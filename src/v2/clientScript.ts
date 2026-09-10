export const MINT_CLIENT_SCRIPT = `(() => {
  const ethereum = window.ethereum;
  const localEnvironment = Boolean(document.querySelector("[data-local-chain-rehearsal]"));
  const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const confirmLocal = (message) => {
    if (!window.confirm("LOCAL TEST WALLET · ANVIL 31337 ONLY\\nPublic test keys. Never send real funds.\\n\\n" + message)) {
      throw new Error("Cancelled. No wallet signature or transaction was sent.");
    }
  };

  const errorMessage = (value) => {
    if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
    return "The wallet action could not be completed.";
  };

  const showRequestError = (error, feedback) => {
    feedback.textContent = errorMessage(error);
    if (!error || typeof error !== "object" || error.code !== "X_REAUTH_REQUIRED") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "auth-action reauth-button";
    const label = document.createElement("span");
    label.textContent = "Reauthenticate with X";
    button.append(label);
    button.addEventListener("click", () => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = "/auth/x/start";
      const purpose = document.createElement("input");
      purpose.type = "hidden";
      purpose.name = "purpose";
      purpose.value = "account_login";
      form.append(purpose);
      if (new RegExp("^/signatures/sg1_[a-z2-7]{52}/mint$").test(location.pathname)) {
        const returnTo = document.createElement("input");
        returnTo.type = "hidden";
        returnTo.name = "return_to";
        returnTo.value = location.pathname;
        form.append(returnTo);
      }
      document.body.append(form);
      form.submit();
    });
    feedback.append(document.createTextNode(" "), button);
  };

  const requestJson = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || "The request was rejected.");
      error.code = payload?.error?.code;
      throw error;
    }
    return payload;
  };

  const canonicalMintCalldata = (payload) => {
    try {
      const authorization = payload.authorization;
      const data = payload.transaction?.data;
      if (!authorization || typeof authorization !== "object" || typeof data !== "string" || !/^0x[0-9a-f]+$/i.test(data)) return false;
      const encoded = data.slice(2).toLowerCase();
      if (encoded.length % 2 !== 0 || encoded.slice(0, 8) !== "f722c561") return false;
      const argumentsHex = encoded.slice(8);
      const wordAt = (byteOffset) => argumentsHex.slice(byteOffset * 2, (byteOffset + 32) * 2);
      const uintWord = (value) => value.toString(16).padStart(64, "0");
      const fixedHex = (value, byteLength) => {
        if (typeof value !== "string" || !new RegExp("^0x[0-9a-f]{" + (byteLength * 2) + "}$", "i").test(value)) return null;
        return value.slice(2).toLowerCase();
      };
      const decimal = (value, bits, requireString) => {
        if (requireString ? typeof value !== "string" : typeof value !== "number") return null;
        if (typeof value === "string" && !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
        if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null;
        const parsed = BigInt(value);
        return parsed < 0n || parsed >= (1n << BigInt(bits)) ? null : parsed;
      };

      const fixedFields = [
        authorization.signatureDigest,
        authorization.walletBindingId,
        authorization.svgSha256,
        authorization.pngSha256,
        authorization.metadataSha256,
        authorization.tokenURIHash,
        authorization.authorizationId,
      ].map((value) => fixedHex(value, 32));
      const mintWallet = fixedHex(authorization.mintWallet, 20);
      const validAfter = decimal(authorization.validAfter, 64, true);
      const deadline = decimal(authorization.deadline, 64, true);
      const authorizerEpoch = decimal(authorization.authorizerEpoch, 32, false);
      if (fixedFields.some((value) => value === null) || mintWallet === null || validAfter === null || deadline === null || authorizerEpoch === null) return false;

      const expectedStaticWords = [
        fixedFields[0],
        fixedFields[1],
        "0".repeat(24) + mintWallet,
        fixedFields[2],
        fixedFields[3],
        fixedFields[4],
        fixedFields[5],
        fixedFields[6],
        uintWord(validAfter),
        uintWord(deadline),
        uintWord(authorizerEpoch),
      ];
      if (expectedStaticWords.some((word, index) => wordAt(index * 32) !== word)) return false;

      if (typeof payload.tokenURI !== "string") return false;
      const tokenBytes = new TextEncoder().encode(payload.tokenURI);
      const tokenHex = Array.from(tokenBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const attestationHex = fixedHex(payload.galleryAttestation, 65);
      if (attestationHex === null) return false;

      const headLength = 13 * 32;
      const paddedTokenLength = Math.ceil(tokenBytes.length / 32) * 32;
      const attestationOffset = headLength + 32 + paddedTokenLength;
      const paddedAttestationLength = Math.ceil(attestationHex.length / 2 / 32) * 32;
      const totalLength = attestationOffset + 32 + paddedAttestationLength;
      if (argumentsHex.length !== totalLength * 2) return false;
      if (wordAt(11 * 32) !== uintWord(BigInt(headLength)) || wordAt(12 * 32) !== uintWord(BigInt(attestationOffset))) return false;

      const tokenDataStart = (headLength + 32) * 2;
      const tokenDataEnd = tokenDataStart + tokenHex.length;
      if (wordAt(headLength) !== uintWord(BigInt(tokenBytes.length)) || argumentsHex.slice(tokenDataStart, tokenDataEnd) !== tokenHex) return false;
      if (!/^0*$/.test(argumentsHex.slice(tokenDataEnd, (headLength + 32 + paddedTokenLength) * 2))) return false;

      const attestationDataStart = (attestationOffset + 32) * 2;
      const attestationDataEnd = attestationDataStart + attestationHex.length;
      if (wordAt(attestationOffset) !== uintWord(BigInt(attestationHex.length / 2)) || argumentsHex.slice(attestationDataStart, attestationDataEnd) !== attestationHex) return false;
      return /^0*$/.test(argumentsHex.slice(attestationDataEnd));
    } catch {
      return false;
    }
  };

  const fixtureWallet = async (button, feedback) => {
    feedback.textContent = "Opening a clearly simulated fixture wallet…";
    await requestJson("/dev/v2/wallet-bindings/seed", {
      method: "POST",
      headers: { "X-CSRF-Token": button.dataset.csrf || "" },
      body: JSON.stringify({ chainId: button.dataset.chainId }),
    });
    location.reload();
  };

  const boundWalletControls = new WeakSet();
  const bindWalletControls = () => {
  document.querySelectorAll("[data-link-wallet]").forEach((button) => {
    if (boundWalletControls.has(button)) return;
    boundWalletControls.add(button);
    button.addEventListener("click", async () => {
      const feedback = button.closest("[data-wallet-controls],[data-account-panel-content]")?.querySelector("[data-wallet-feedback]") || document.querySelector("[data-wallet-feedback]");
      if (!feedback || button.disabled) return;
      button.disabled = true;
      try {
        const localWalletEnvironment = Boolean(document.querySelector("[data-local-chain-rehearsal]"));
        const useLocalWallet = localWalletEnvironment && button.dataset.walletProvider === "local";
        if (!localWalletEnvironment && button.dataset.walletProvider === "fixture" && button.dataset.fixture === "true") {
          await fixtureWallet(button, feedback);
          return;
        }
        if (!useLocalWallet && !ethereum) {
          throw new Error("No injected Ethereum wallet was found in this browser.");
        }
        feedback.textContent = "Waiting for your wallet address…";
        const localWallet = useLocalWallet ? await requestJson("/api/local/wallet") : null;
        if (useLocalWallet && (localWallet.chainId !== "31337" || button.dataset.chainId !== "31337")) throw new Error("Local TEST wallet is available only on Anvil 31337.");
        const accounts = useLocalWallet ? [localWallet.address] : await ethereum.request({ method: "eth_requestAccounts" });
        const walletAddress = Array.isArray(accounts) ? accounts[0] : null;
        if (typeof walletAddress !== "string") throw new Error("The wallet returned no address.");
        const challenge = await requestJson("/api/v2/wallet-bindings/challenge", {
          method: "POST",
          headers: { "X-CSRF-Token": button.dataset.csrf || "" },
          body: JSON.stringify({ walletAddress, chainId: button.dataset.chainId }),
        });
        feedback.textContent = "Sign the exact one-time link message in your wallet.";
        let walletProof;
        if (useLocalWallet) {
          confirmLocal("Sign this exact one-time wallet-link message?\\n\\n" + challenge.message);
          ({ walletProof } = await requestJson("/api/local/wallet/sign", { method: "POST", headers: { "X-CSRF-Token": button.dataset.csrf || "" }, body: JSON.stringify({ challengeId: challenge.challengeId }) }));
        } else {
          walletProof = await ethereum.request({ method: "personal_sign", params: [challenge.message, walletAddress] });
        }
        await requestJson("/api/v2/wallet-bindings/confirm", {
          method: "POST",
          headers: { "X-CSRF-Token": button.dataset.csrf || "" },
          body: JSON.stringify({ challengeId: challenge.challengeId, walletProof }),
        });
        feedback.textContent = "Wallet linked for minting.";
        location.reload();
      } catch (error) {
        showRequestError(error, feedback);
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-revoke-wallet]").forEach((button) => {
    if (boundWalletControls.has(button)) return;
    boundWalletControls.add(button);
    button.addEventListener("click", async () => {
      const feedback = button.closest("[data-wallet-controls],[data-account-panel-content]")?.querySelector("[data-wallet-feedback]") || document.querySelector("[data-wallet-feedback]");
      if (!feedback || button.disabled) return;
      button.disabled = true;
      try {
        await requestJson("/api/v2/wallet-bindings/current", {
          method: "DELETE",
          headers: { "X-CSRF-Token": button.dataset.csrf || "" },
          body: "{}",
        });
        feedback.textContent = "Wallet binding revoked.";
        location.reload();
      } catch (error) {
        showRequestError(error, feedback);
        button.disabled = false;
      }
    });
  });
  };
  bindWalletControls();
  window.addEventListener("account-panel:ready", bindWalletControls);

  document.querySelectorAll(".mint-authorization-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const feedback = (event.submitter?.dataset.walletProvider === "local" ? document.querySelector("[data-dev-mint-controls] [data-mint-feedback]") : null) || form.parentElement?.querySelector("[data-mint-feedback]");
      const button = form.querySelector("button[type=submit]");
      const consent = form.querySelector("input[name=permanence_acknowledged]");
      if (!feedback || !button || button.disabled || !consent?.checked) return;
      button.disabled = true;
      try {
        feedback.textContent = "Preparing and signing the exact mint authorization…";
        const csrf = form.querySelector("input[name=csrf]")?.value || "";
        const payload = await requestJson(form.action, {
          method: "POST",
          headers: { "X-CSRF-Token": csrf, "X-Mint-Permanence-Acknowledged": "1" },
          body: "{}",
        });
        const authorization = payload.authorization;
        const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
        if (
          payload.chainId !== form.dataset.chainId ||
          !same(payload.contract, form.dataset.contract) ||
          !payload.transaction ||
          !same(payload.transaction.to, payload.contract) ||
          payload.transaction.value !== "0x0" ||
          !canonicalMintCalldata(payload) ||
          !same(authorization.mintWallet, form.dataset.wallet) ||
          !same(authorization.signatureDigest, form.dataset.signatureDigest) ||
          !same(authorization.svgSha256, "0x" + form.dataset.svgSha256) ||
          !same(authorization.pngSha256, "0x" + form.dataset.pngSha256) ||
          !same(authorization.metadataSha256, form.dataset.metadataSha256) ||
          !same(authorization.tokenURIHash, form.dataset.tokenUriHash) ||
          payload.tokenURI !== form.dataset.tokenUri
        ) throw new Error("The returned authorization does not match the reviewed work.");

        const actualLocal = localEnvironment && form.dataset.localChainRehearsal === "true" && payload.localChainRehearsal === true && payload.chainId === "31337";
        if (payload.fixture === true && !actualLocal) {
          feedback.textContent = "Authorization saved. No transaction submitted.";
          setTimeout(() => { location.href = "/me"; }, 900);
          return;
        }
        if (localEnvironment && !actualLocal) throw new Error("The server did not confirm an actual local Anvil transaction. Nothing was sent.");
        const useLocalWallet = actualLocal && form.dataset.localWallet === "true" && event.submitter?.dataset.walletProvider === "local";
        if (useLocalWallet) {
          const localWallet = await requestJson("/api/local/wallet");
          if (localWallet.chainId !== "31337" || !same(localWallet.address, authorization.mintWallet) || !same(localWallet.contract, payload.contract)) throw new Error("The local TEST wallet does not match the reviewed wallet and contract.");
          confirmLocal("Submit this zero-project-fee mint? Only local test ETH pays gas.\\n\\nWallet: " + authorization.mintWallet + "\\nContract: " + payload.contract + "\\nSignature: " + form.dataset.signatureId + "\\nMetadata: " + payload.tokenURI + "\\n\\nThis sends a real transaction to your local Anvil node. IPFS publication and finality are local rehearsals, not Ethereum provenance.");
          feedback.textContent = "Simulating and submitting the exact mint on local Anvil…";
          const sent = await requestJson("/api/local/wallet/mint", { method: "POST", headers: { "X-CSRF-Token": csrf, "X-Mint-Permanence-Acknowledged": "1" }, body: JSON.stringify({ authorizationId: authorization.authorizationId }) });
          feedback.textContent = "Anvil transaction submitted: " + sent.txHash + ". Waiting for automatic local promotion, not Ethereum finality.";
          await requestJson("/api/v2/mint-authorizations/" + authorization.authorizationId + "/transactions", { method: "POST", headers: { "X-CSRF-Token": csrf }, body: JSON.stringify({ txHash: sent.txHash }) }).catch(() => undefined);
          setTimeout(() => { location.href = "/me"; }, 1200);
          return;
        }
        if (!ethereum) throw new Error("No injected Ethereum wallet was found in this browser.");
        const accounts = await ethereum.request({ method: "eth_accounts" });
        const connected = Array.isArray(accounts) ? accounts[0] : null;
        if (!same(connected, authorization.mintWallet)) throw new Error("Connect the exact wallet linked to this X account.");
        const currentChain = await ethereum.request({ method: "eth_chainId" });
        const expectedChain = "0x" + BigInt(payload.chainId).toString(16);
        if (currentChain !== expectedChain) {
          await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expectedChain }] });
        }
        const transaction = { from: authorization.mintWallet, to: payload.transaction.to, data: payload.transaction.data, value: payload.transaction.value };
        feedback.textContent = "Simulating the exact contract call and estimating network gas…";
        await ethereum.request({ method: "eth_call", params: [transaction, "latest"] });
        const gas = await ethereum.request({ method: "eth_estimateGas", params: [transaction] });
        // Wallet state may change while either simulation or estimation awaits.
        // Recheck at submission and pin the request itself to the reviewed chain.
        const [submissionChain, submissionAccounts] = await Promise.all([
          ethereum.request({ method: "eth_chainId" }),
          ethereum.request({ method: "eth_accounts" }),
        ]);
        if (submissionChain !== expectedChain) throw new Error("The wallet network changed during review. Return to the reviewed network and try again. Nothing was sent.");
        if (!same(Array.isArray(submissionAccounts) ? submissionAccounts[0] : null, authorization.mintWallet)) throw new Error("The wallet account changed during review. Reconnect the exact linked wallet and try again. Nothing was sent.");
        const txHash = await ethereum.request({ method: "eth_sendTransaction", params: [{ ...transaction, gas, chainId: expectedChain }] });
        feedback.textContent = "Transaction submitted. This is not minted until the finalized event is validated.";
        await requestJson("/api/v2/mint-authorizations/" + authorization.authorizationId + "/transactions", {
          method: "POST",
          headers: { "X-CSRF-Token": csrf },
          body: JSON.stringify({ txHash }),
        }).catch(() => undefined);
        setTimeout(() => { location.href = "/me"; }, 1200);
      } catch (error) {
        showRequestError(error, feedback);
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-local-transfer]").forEach((button) => {
    button.addEventListener("click", async () => {
      const feedback = button.parentElement?.querySelector("[data-transfer-feedback]");
      if (!feedback || !localEnvironment || button.disabled) return;
      button.disabled = true;
      try {
        const wallet = await requestJson("/api/local/wallet");
        if (wallet.chainId !== "31337" || !sameAddress(wallet.address, button.dataset.owner) || !sameAddress(wallet.recipientAddress, button.dataset.recipient)) throw new Error("The local transfer no longer matches the displayed wallets.");
        confirmLocal("Transfer token " + button.dataset.tokenId + "?\\n\\nFrom: " + wallet.address + "\\nTo: " + wallet.recipientAddress + "\\nContract: " + wallet.contract + "\\n\\nThis is a real local Anvil transaction to the fixed second TEST wallet. The original claim stays with this account.");
        const sent = await requestJson("/api/local/wallet/transfer", { method: "POST", headers: { "X-CSRF-Token": button.dataset.csrf || "" }, body: JSON.stringify({ signatureId: button.dataset.signatureId }) });
        feedback.textContent = "Anvil transfer submitted: " + sent.txHash + ". Waiting for the local holder projection…";
        let tries = 0;
        const check = async () => {
          try {
            const status = await requestJson("/api/v2/signatures/" + button.dataset.signatureId + "/mint-status");
            if (sameAddress(status.currentTokenHolder, wallet.recipientAddress)) { location.reload(); return; }
          } catch { /* A temporary read failure does not imply transaction failure. */ }
          if (++tries < 30) setTimeout(check, 1500);
          else feedback.textContent = "Transfer submitted: " + sent.txHash + ". Indexing is taking longer; refresh to check its status. Do not resubmit.";
        };
        setTimeout(check, 1500);
      } catch (error) {
        showRequestError(error, feedback);
        button.disabled = false;
      }
    });
  });

  if (localEnvironment) document.querySelectorAll("[data-local-mint-pending]").forEach((element) => {
    let tries = 0;
    const check = async () => {
      try {
        const status = await requestJson("/api/v2/signatures/" + element.dataset.signatureId + "/mint-status");
        if (status.state !== element.dataset.mintState) { location.reload(); return; }
      } catch { /* Retry transient reads without treating them as chain failure. */ }
      if (++tries < 40) setTimeout(check, 1500);
    };
    setTimeout(check, 1500);
  });

  document.querySelectorAll("[data-advance-rehearsal]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await requestJson("/dev/v2/signatures/" + button.dataset.signatureId + "/advance", {
          method: "POST",
          headers: { "X-CSRF-Token": button.dataset.csrf || "" },
          body: "{}",
        });
        location.reload();
      } catch (error) {
        const label = button.querySelector("span");
        if (label) label.textContent = errorMessage(error);
        button.disabled = false;
      }
    });
  });
})();`;
