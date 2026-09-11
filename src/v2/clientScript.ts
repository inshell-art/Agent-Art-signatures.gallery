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

  const showRequestError = (error, feedback, actionContext) => {
    feedback.textContent = errorMessage(error);
    if (!error || typeof error !== "object") return;
    const targetMintPath = /^sg1_[a-z2-7]{52}$/.test(actionContext?.signatureId || "") ? "/signatures/" + actionContext.signatureId + "/mint" : null;
    if (["MINT_RECIPIENT_REQUIRED", "X_ACTION_CONFIRMATION_REQUIRED", "BINDING_TRANSITION", "WALLET_CHALLENGE_INVALID"].includes(error.code)) {
      const mintPath = targetMintPath || (new RegExp("^/signatures/sg1_[a-z2-7]{52}/mint$").test(location.pathname) ? location.pathname : null);
      if (mintPath) {
        const link = document.createElement("a");
        link.className = "auth-action";
        link.href = mintPath;
        const label = document.createElement("span");
        label.textContent = "Review mint";
        link.append(label);
        feedback.append(document.createTextNode(" "), link);
      }
      return;
    }
    const sessionExpired = error.code === "AUTH_REQUIRED" || error.code === "AUTH_EXPIRED";
    if (!sessionExpired) return;
    feedback.textContent = "Session expired. Sign in to continue.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "auth-action";
    const label = document.createElement("span");
    label.textContent = "Sign in with X";
    button.append(label);
    button.addEventListener("click", () => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = "/auth/x/start";
      const hidden = (name, value) => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      };
      hidden("purpose", "account_login");
      const returnTo = targetMintPath || (new RegExp("^/signatures/sg1_[a-z2-7]{52}(?:/mint)?$").test(location.pathname) ? location.pathname : "/me");
      hidden("return_to", returnTo);
      document.body.append(form);
      feedback.textContent = "Opening X to sign in…";
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

  const fixtureWallet = async (button, feedback, recipientContext) => {
    feedback.textContent = "Opening a clearly simulated fixture wallet…";
    await requestJson("/dev/v2/wallet-bindings/seed", {
      method: "POST",
      headers: { "X-CSRF-Token": button.dataset.csrf || "" },
      body: JSON.stringify({ ...recipientContext, recipientConsent: true }),
    });
    location.replace("/signatures/" + recipientContext.signatureId + "/mint");
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
      const recipientContext = { chainId: button.dataset.chainId, signatureId: button.dataset.signatureId, claimInstanceId: button.dataset.claimInstanceId,
        previousBindingId: button.dataset.previousBindingId === "" ? null : button.dataset.previousBindingId };
      try {
        if (!recipientContext.signatureId || !recipientContext.claimInstanceId) throw new Error("Return to this signature’s mint page to verify its recipient.");
        if (recipientContext.previousBindingId !== null && !/^0x[0-9a-f]{64}$/i.test(recipientContext.previousBindingId || "")) throw new Error("The previous recipient is not available. Open the mint page again.");
        const localWalletEnvironment = Boolean(document.querySelector("[data-local-chain-rehearsal]"));
        const useLocalWallet = localWalletEnvironment && button.dataset.walletProvider === "local";
        if (!localWalletEnvironment && button.dataset.walletProvider === "fixture" && button.dataset.fixture === "true") {
          await fixtureWallet(button, feedback, recipientContext);
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
          body: JSON.stringify({ walletAddress, ...recipientContext, recipientConsent: true }),
        });
        if (!sameAddress(challenge.walletAddress, walletAddress) || challenge.chainId !== button.dataset.chainId) throw new Error("The wallet proof does not match the selected recipient and network. Nothing was signed.");
        feedback.textContent = "Sign the one-time message to verify this mint’s recipient. This does not mint or send a transaction.";
        let walletProof;
        if (useLocalWallet) {
          confirmLocal("Verify this mint’s recipient with this one-time message?\\n\\n" + challenge.message);
          ({ walletProof } = await requestJson("/api/local/wallet/sign", { method: "POST", headers: { "X-CSRF-Token": button.dataset.csrf || "" }, body: JSON.stringify({ challengeId: challenge.challengeId }) }));
        } else {
          walletProof = await ethereum.request({ method: "personal_sign", params: [challenge.message, walletAddress] });
        }
        await requestJson("/api/v2/wallet-bindings/confirm", {
          method: "POST",
          headers: { "X-CSRF-Token": button.dataset.csrf || "" },
          body: JSON.stringify({ challengeId: challenge.challengeId, walletProof }),
        });
        feedback.textContent = "Recipient verified for this mint.";
        // Drop ?recipient=change after proof; reloading it would force the
        // wallet-selection stage instead of opening this recipient's review.
        location.replace("/signatures/" + recipientContext.signatureId + "/mint");
      } catch (error) {
        showRequestError(error, feedback, recipientContext);
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
      const reviewed = { ...form.dataset };
      const reviewedRecipientUnchanged = () => form.dataset.walletBindingId === reviewed.walletBindingId && sameAddress(form.dataset.wallet, reviewed.wallet)
        && form.dataset.signatureId === reviewed.signatureId && form.dataset.claimInstanceId === reviewed.claimInstanceId;
      try {
        if (!/^0x[0-9a-f]{64}$/i.test(reviewed.walletBindingId || "") || !/^0x[0-9a-f]{40}$/i.test(reviewed.wallet || "")) throw new Error("Verify the recipient for this mint before authorizing.");
        feedback.textContent = "Preparing and signing the exact mint authorization…";
        const csrf = form.querySelector("input[name=csrf]")?.value || "";
        const payload = await requestJson(form.action, {
          method: "POST",
          headers: { "X-CSRF-Token": csrf, "X-Mint-Permanence-Acknowledged": "1" },
          body: JSON.stringify({ walletBindingId: reviewed.walletBindingId, recipient: reviewed.wallet }),
        });
        const authorization = payload.authorization;
        const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
        if (
          !reviewedRecipientUnchanged() ||
          payload.chainId !== reviewed.chainId ||
          !same(payload.contract, reviewed.contract) ||
          !payload.transaction ||
          !same(payload.transaction.to, payload.contract) ||
          payload.transaction.value !== "0x0" ||
          !canonicalMintCalldata(payload) ||
          !same(authorization.walletBindingId, reviewed.walletBindingId) ||
          !same(authorization.mintWallet, reviewed.wallet) ||
          !same(authorization.signatureDigest, reviewed.signatureDigest) ||
          !same(authorization.svgSha256, "0x" + reviewed.svgSha256) ||
          !same(authorization.pngSha256, "0x" + reviewed.pngSha256) ||
          !same(authorization.metadataSha256, reviewed.metadataSha256) ||
          !same(authorization.tokenURIHash, reviewed.tokenUriHash) ||
          payload.tokenURI !== reviewed.tokenUri
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
          if (!reviewedRecipientUnchanged()) throw new Error("The reviewed recipient changed. Review this mint again. Nothing was sent.");
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
        if (!same(connected, authorization.mintWallet)) throw new Error("Connect the exact recipient verified for this mint.");
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
        if (!same(Array.isArray(submissionAccounts) ? submissionAccounts[0] : null, authorization.mintWallet)) throw new Error("The wallet account changed during review. Reconnect the verified recipient and try again. Nothing was sent.");
        if (!reviewedRecipientUnchanged()) throw new Error("The reviewed recipient changed. Review this mint again. Nothing was sent.");
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
