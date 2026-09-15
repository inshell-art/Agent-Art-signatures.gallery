/** Explicit wallet-gated mint intent; reveal only after verified chain confirmation. */
export const OPEN_MINT_CLIENT_SCRIPT = String.raw`(() => {
  if (window.__openMintBound) return;
  window.__openMintBound = true;
  const one = (selector) => document.querySelector(selector);
  const all = (selector) => document.querySelectorAll(selector);
  const root = one('[data-open-mint]');
  if (!root) return;
  const candidate = one('[data-assessment-code]');
  const page = /^[A-Za-z0-9_-]{43}$/.test(candidate?.dataset.assessmentCode || '') ? candidate : null;
  const code = page?.dataset.assessmentCode || '';
  const handle = page?.dataset.assessmentHandle || '';
  const tokenId = page?.dataset.tokenId || '';
  const local = root.dataset.localChain === 'true';
  const addressPattern = /^0x[0-9a-f]{40}$/i;
  const hashPattern = /^0x[0-9a-f]{64}$/i;
  const codePattern = /^[A-Za-z0-9_-]{43}$/;
  const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const walletAddress = (value) => typeof value === 'string' ? value : value?.wallet?.address || value?.wallet || value?.address;
  const message = (selector, text) => { const node = one(selector); if (node) node.textContent = text; };
  const feedback = (text) => message('[data-mint-feedback]', text);
  const storageGet = (key) => { try { return JSON.parse(sessionStorage.getItem('sg-open:' + key) || 'null'); } catch { return null; } };
  const storageSet = (key, value) => { try { sessionStorage.setItem('sg-open:' + key, JSON.stringify(value)); } catch {} };
  const storageRemove = (key) => { try { sessionStorage.removeItem('sg-open:' + key); } catch {} };
  const intentKey = 'intent:' + code;
  const submissionKey = 'submission:' + code;
  let stopped = false, timer, sessionPromise, verified = null, walletMode = 'injected';
  let walletBusy = false, mintBusy = false, requestBusy = false, walletGeneration = 0;
  let submittedHash = null, uncertainSubmission = false, reportNeeded = false;
  let submittedWallet = null, submittedAt = 0, expectedNonce = null;
  let inspectionGeneration = 0;
  const delayedConfirmationMs = 30000;
  const abort = new AbortController();
  const asChain = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('The mint network is unavailable. Reload this page.');
    const chain = BigInt(value);
    if (chain <= 0n) throw new Error('The mint network is unavailable. Reload this page.');
    return '0x' + chain.toString(16);
  };
  const errorText = (error) => {
    if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'Cancelled in your wallet. Your prepared signature is unchanged. Choose Continue mint when ready.';
    if (['REQUEST_EXPIRED', 'SESSION_EXPIRED', 'SESSION_REQUIRED', 'CSRF_INVALID', 'CSRF_FAILED'].includes(error?.code)) return 'This request or browser session has expired. Return to Mint to continue with the same assessment.';
    if (['TOKEN_ALREADY_MINTED', 'HANDLE_ALREADY_MINTED', 'ALREADY_MINTED'].includes(error?.code)) return 'This handle already has a token or is confirming.';
    if (['TOKEN_BINDING_MISMATCH', 'WALLET_PROOF_REQUIRED', 'WALLET_MISMATCH', 'WALLET_CHANGED', 'REQUEST_NOT_OWNED', 'REQUEST_SESSION_MISMATCH'].includes(error?.code)) return 'Connect and verify the wallet for this request again.';
    return typeof error?.message === 'string' ? error.message : 'The request could not be completed. Please try again.';
  };
  const updateButtons = () => {
    all('[data-assessment-request]').forEach((form) => {
      const button = form.querySelector('button[type=submit]');
      if (button) button.disabled = !verified || walletBusy || mintBusy || requestBusy;
    });
    const blocked = !verified || walletBusy || mintBusy || submittedHash || uncertainSubmission || ['pending', 'minted'].includes(page?.dataset.mintState) || page?.dataset.assessmentState !== 'ready' || page?.dataset.canMint !== 'true';
    const mint = one('[data-submit-mint]');
    if (mint) mint.disabled = Boolean(blocked || walletMode !== 'injected');
    const dev = one('[data-dev-mint]');
    if (dev) dev.disabled = Boolean(blocked || walletMode !== 'local');
  };
  const invalidateWallet = () => { walletGeneration++; verified = null; storageRemove(intentKey); storageRemove('wallet-mode'); updateButtons(); };
  const readJson = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'same-origin', signal: abort.signal, ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '') || 'The request was rejected.');
      error.code = payload?.error?.code || payload?.code;
      error.url = payload?.url;
      throw error;
    }
    return payload;
  };
  const session = async () => {
    if (!sessionPromise) sessionPromise = readJson('/api/session').catch((error) => { sessionPromise = null; throw error; });
    const state = await sessionPromise;
    if (!state.csrfToken || typeof state.csrfToken !== 'string') throw new Error('Your browser session is unavailable. Reload this page.');
    return state;
  };
  const post = async (path, body, beforeSend) => {
    const state = await session();
    beforeSend?.();
    return readJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: JSON.stringify(body) });
  };
  const expectedChain = (state) => {
    const chain = asChain(state.chainId);
    if (root.dataset.chainId && asChain(root.dataset.chainId) !== chain) throw new Error('The mint network changed. Reload before continuing.');
    return chain;
  };
  const provider = () => {
    if (!window.ethereum?.request) throw new Error('No Ethereum wallet was found. Open this page in a browser with a wallet.');
    return window.ethereum;
  };
  const isQuantity = (value) => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  const quantity = (value) => {
    if (!isQuantity(value)) throw new Error('The wallet network proof or transaction nonce is invalid. Nothing was sent. Reload before continuing.');
    return value;
  };
  const validateNetwork = (context, state) => {
    if (!context || quantity(context.chainId) !== expectedChain(state) || !addressPattern.test(context.contract || '') || !sameAddress(context.contract, root.dataset.contract) || !hashPattern.test(context.blockHash || '')) throw new Error('The mint network proof does not match this page. Nothing was sent. Reload before continuing.');
    quantity(context.blockNumber);
    return context;
  };
  const verifyNetwork = async (ethereum, state, context) => {
    validateNetwork(context, state);
    const block = await ethereum.request({ method: 'eth_getBlockByNumber', params: [context.blockNumber, false] });
    if (!block || block.number !== context.blockNumber || !sameAddress(block.hash, context.blockHash) || asChain(await ethereum.request({ method: 'eth_chainId' })) !== expectedChain(state)) throw Object.assign(new Error(local && state.rpcUrl ? 'Your wallet is connected to a different local chain. Set its RPC to ' + state.rpcUrl + ', then reconnect.' : 'Your wallet is connected to a different chain. Check its RPC and reconnect.'), { code: 'WALLET_NETWORK_MISMATCH' });
  };
  const walletUnchanged = async (ethereum, state, address, generation, requireVerified = true) => {
    const accounts = await ethereum.request({ method: 'eth_accounts' });
    const chain = await ethereum.request({ method: 'eth_chainId' });
    if (stopped || generation !== walletGeneration || !sameAddress(accounts?.[0], address) || asChain(chain) !== expectedChain(state) || (requireVerified && !sameAddress(verified, address))) throw new Error('The wallet changed during preparation. Connect it again.');
  };
  const ensureChain = async (ethereum, state) => {
    const chainId = expectedChain(state);
    if (asChain(await ethereum.request({ method: 'eth_chainId' })) !== chainId) {
      try { await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
      catch (error) {
        if (Number(error?.code) !== 4902 || !local || !state.rpcUrl) throw error;
        const rpc = new URL(state.rpcUrl);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname) || !['http:', 'https:'].includes(rpc.protocol)) throw new Error('The local chain RPC must use a loopback address.');
        await ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: state.chainName || 'Local test chain', rpcUrls: [rpc.href], nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 } }] });
        await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
    }
    if (asChain(await ethereum.request({ method: 'eth_chainId' })) !== chainId) throw new Error('Switch your wallet to the mint network and try again.');
    const context = await readJson('/api/wallet/context', { cache: 'no-store' });
    await verifyNetwork(ethereum, state, context);
    return context;
  };
  const assertContext = () => {
    if (!page || !codePattern.test(code) || page.dataset.assessmentCode !== code || page.dataset.assessmentHandle !== handle || page.dataset.tokenId !== tokenId || page.dataset.assessmentState !== 'ready' || page.dataset.canMint !== 'true') throw new Error('This request is not ready to mint in this browser session.');
  };
  const walletReady = (address, state, mode) => {
    if (!addressPattern.test(address || '')) throw new Error('The wallet verification response was invalid.');
    verified = address; walletMode = mode;
    storageSet('wallet-mode', { address, mode });
    message('[data-wallet-label]', address); updateButtons();
  };
  const reveal = () => {
    storageRemove(intentKey); storageRemove(submissionKey);
    if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) location.assign('/signatures/' + encodeURIComponent(handle));
  };
  const schedule = (callback, delay = 2500) => { clearTimeout(timer); if (!stopped) timer = setTimeout(callback, delay); };
  const boundedCheck = (promise) => {
    let timeout;
    return Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Confirmation check timed out.')), 8000); })]).finally(() => clearTimeout(timeout));
  };
  const pendingFeedback = (text, status = 'Mint submitted. Waiting to reveal your signature…') => {
    feedback(text); message('[data-assessment-status]', status);
    message('[data-poll-feedback]', 'Transaction: ' + submittedHash);
  };
  const inspectSubmissionRead = async (mintState, inspection) => {
    if (!submittedHash || walletMode !== 'injected' || stopped) return false;
    const hash = submittedHash, generation = walletGeneration;
    try {
      const ethereum = provider(), state = await session();
      if (asChain(await ethereum.request({ method: 'eth_chainId' })) !== expectedChain(state)) throw Object.assign(new Error('Wrong wallet network'), { code: 'WALLET_NETWORK_MISMATCH' });
      const context = await readJson('/api/wallet/context', { cache: 'no-store' });
      await verifyNetwork(ethereum, state, context);
      if (!addressPattern.test(submittedWallet || '')) throw new Error('The original transaction wallet is unavailable.');
      const [tx, latest, pending, receipt] = await Promise.all([
        ethereum.request({ method: 'eth_getTransactionByHash', params: [hash] }),
        ethereum.request({ method: 'eth_getTransactionCount', params: [submittedWallet, 'latest'] }),
        ethereum.request({ method: 'eth_getTransactionCount', params: [submittedWallet, 'pending'] }),
        mintState === 'unminted' ? ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] }) : Promise.resolve(null),
      ]);
      // A wallet may change RPC during these reads, even without a chainChanged event.
      await verifyNetwork(ethereum, state, context);
      if (stopped || submittedHash !== hash || generation !== walletGeneration || inspection !== inspectionGeneration) return false;
      if (!isQuantity(latest) || !isQuantity(pending) || BigInt(pending) < BigInt(latest)) throw new Error('Invalid transaction counts');
      const delayed = Date.now() - submittedAt >= delayedConfirmationMs;
      if (tx === null) {
        pendingFeedback(delayed ? 'The transaction is not currently visible on the verified mint network. It may still be propagating or may have been dropped. Check wallet activity; do not submit another mint until this transaction is resolved.' : 'Transaction submitted. Waiting for it to appear on the mint network.', delayed ? 'Transaction not found. Check wallet activity.' : undefined);
        return false;
      }
      if (!tx || !sameAddress(tx.hash, hash) || !sameAddress(tx.from, submittedWallet) || !sameAddress(tx.to, root.dataset.contract) || !isQuantity(tx.nonce) || !(tx.blockNumber === null || isQuantity(tx.blockNumber)) || (tx.chainId !== undefined && (!isQuantity(tx.chainId) || tx.chainId !== expectedChain(state)))) {
        pendingFeedback('The wallet returned transaction details that do not match this mint. Check wallet activity; do not submit another mint until this transaction is resolved.', 'Transaction details could not be verified.');
        return false;
      }
      if (mintState === 'unminted' && receipt?.status === '0x0' && sameAddress(receipt.transactionHash, hash) && sameAddress(receipt.from, submittedWallet) && sameAddress(receipt.to, root.dataset.contract) && isQuantity(receipt.blockNumber) && tx.blockNumber === receipt.blockNumber && hashPattern.test(receipt.blockHash || '')) {
        const receiptBlock = await ethereum.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] });
        await verifyNetwork(ethereum, state, context);
        if (stopped || submittedHash !== hash || generation !== walletGeneration || inspection !== inspectionGeneration) return false;
        if (receiptBlock?.number !== receipt.blockNumber || !sameAddress(receiptBlock.hash, receipt.blockHash)) throw new Error('The reverted receipt is not on the verified chain.');
        submittedHash = null; uncertainSubmission = false; expectedNonce = null; storageRemove(submissionKey);
        page.dataset.mintState = 'unminted';
        message('[data-poll-feedback]', '');
        message('[data-assessment-status]', 'The mint transaction reverted. Your signature is ready to mint.');
        feedback('The transaction reverted. Your prepared signature is unchanged. You can Continue mint.');
        updateButtons(); return true;
      }
      if (tx.blockNumber === null && BigInt(tx.nonce) > BigInt(pending)) {
        pendingFeedback('Transaction nonce ' + BigInt(tx.nonce) + '; chain expects ' + BigInt(pending) + '. This transaction is queued behind a nonce gap. Correct the ' + (local ? 'local ' : '') + 'wallet nonce, and do not submit another mint until this transaction is resolved.', 'Mint waiting for a wallet nonce gap to be resolved.');
      } else if (expectedNonce !== null && tx.nonce !== expectedNonce) {
        pendingFeedback('Your wallet broadcast transaction nonce ' + BigInt(tx.nonce) + '; the mint requested ' + BigInt(expectedNonce) + '. Check wallet activity; do not submit another mint until this transaction is resolved.', 'The wallet changed the mint transaction nonce.');
      } else if (tx.blockNumber !== null) {
        pendingFeedback('The transaction was mined. Waiting for the server to verify the mint before revealing your signature.');
      } else {
        pendingFeedback(delayed ? 'The transaction is still pending on the mint network. Confirmation is taking longer than expected. Check wallet activity; do not submit another mint until this transaction is resolved.' : 'Transaction submitted. Waiting for confirmation to reveal your signature.', delayed ? 'Mint confirmation is taking longer than expected.' : undefined);
      }
    } catch (error) {
      if (stopped || submittedHash !== hash || inspection !== inspectionGeneration) return false;
      if (error?.code === 'WALLET_NETWORK_MISMATCH') {
        pendingFeedback('Transaction checking is paused because your wallet is on a different mint network. Restore the correct wallet RPC/network; do not submit another mint while this transaction is unresolved.', 'Switch back to the mint network to check this transaction.');
      } else {
        message('[data-poll-feedback]', 'Transaction checking is temporarily unavailable. This page will retry. Do not submit another mint. Transaction: ' + hash);
      }
    }
    return false;
  };
  const inspectSubmission = async (mintState) => {
    if (!submittedHash || walletMode !== 'injected' || stopped) return false;
    const inspection = ++inspectionGeneration;
    try { return await boundedCheck(inspectSubmissionRead(mintState, inspection)); }
    catch {
      if (!stopped && inspection === inspectionGeneration) {
        inspectionGeneration++;
        message('[data-poll-feedback]', 'Transaction checking is temporarily unavailable. This page will retry. Do not submit another mint. Transaction: ' + submittedHash);
      }
      return false;
    }
  };
  const pollMint = async () => {
    if (stopped || !code) return;
    let result;
    try {
      if (submittedHash && reportNeeded) {
        try { await boundedCheck(post('/api/mints/report', { code, transactionHash: submittedHash })); reportNeeded = false; } catch {}
      }
      result = await boundedCheck(readJson('/api/mints/status/' + encodeURIComponent(code)));
      if (result.state === 'minted') { reveal(); return; }
    } catch { if (!stopped) message('[data-poll-feedback]', 'Confirmation is temporarily unavailable. This page will retry.' + (submittedHash ? ' Transaction: ' + submittedHash : '')); }
    if (await inspectSubmission(result?.state)) return;
    if (!stopped && (!result || result.state === 'pending' || submittedHash || uncertainSubmission || page?.dataset.mintState === 'pending')) schedule(pollMint, result ? 2500 : 8000);
  };
  const setPending = (hash, wallet, nonce = null) => {
    submittedHash = hash; uncertainSubmission = false;
    submittedWallet = wallet; submittedAt = Date.now(); expectedNonce = nonce;
    storageSet(submissionKey, { hash, wallet, mode: walletMode, submittedAt, expectedNonce });
    if (page) page.dataset.mintState = 'pending';
    message('[data-assessment-status]', 'Mint submitted. Waiting to reveal your signature…');
    feedback('Transaction submitted. Waiting for confirmation to reveal your signature.'); updateButtons();
  };
  const expiryTime = (value) => {
    if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return expiryTime(Number(value));
    return Date.parse(value);
  };
  const validateAuthorization = (result, state, recipient) => {
    assertContext();
    const tx = result.transaction;
    const expires = expiryTime(result.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('This mint authorization has expired. Continue mint for a fresh authorization.');
    if (result.code !== code || result.handle !== handle || String(result.tokenId) !== tokenId) throw new Error('The mint authorization is for a different work. Nothing was sent.');
    if (!tx || !sameAddress(tx.from, recipient) || !addressPattern.test(tx.to || '') || !addressPattern.test(root.dataset.contract || '') || !sameAddress(tx.to, root.dataset.contract) || asChain(tx.chainId) !== expectedChain(state) || !/^0x(?:[0-9a-f]{2})+$/i.test(tx.data || '') || !/^0x[0-9a-f]+$/i.test(tx.value || '') || BigInt(tx.value) !== 0n) throw new Error('The mint transaction does not match the wallet, network, and work. Nothing was sent.');
    const network = validateNetwork(result.network, state);
    if (quantity(tx.nonce) !== quantity(network.nonce)) throw new Error('The mint transaction nonce does not match its network proof. Nothing was sent. Continue mint for a fresh authorization.');
    return { from: recipient, to: tx.to, data: tx.data, value: '0x0', chainId: expectedChain(state), nonce: tx.nonce };
  };
  const submitMint = async (mode) => {
    if (stopped || mintBusy || submittedHash || uncertainSubmission || !verified || walletMode !== mode) return;
    mintBusy = true; storageRemove(intentKey); updateButtons();
    const recipient = verified, generation = walletGeneration;
    let sending = false;
    try {
      assertContext();
      const state = await session();
      if (mode === 'local') {
        if (!local || expectedChain(state) !== '0x7a69') throw new Error('Local test minting is available only on chain 31337.');
        sending = true; storageSet(submissionKey, { uncertain: true, wallet: recipient, mode });
        const result = await post('/api/dev/mint', { code, consent: true });
        if (result.state === 'minted') { reveal(); return; }
        if (!hashPattern.test(result.transactionHash || '')) throw new Error('The local wallet returned no valid transaction hash.');
        setPending(result.transactionHash, recipient);
      } else {
        const ethereum = provider(); await ensureChain(ethereum, state);
        await walletUnchanged(ethereum, state, recipient, generation);
        feedback('Preparing your mint authorization…');
        const result = await post('/api/mints/authorize', { code, consent: true }, () => {
          if (stopped || generation !== walletGeneration || !sameAddress(verified, recipient)) throw new Error('The wallet changed. Connect it again.');
        });
        const transaction = validateAuthorization(result, state, recipient);
        await verifyNetwork(ethereum, state, result.network);
        const fresh = await readJson('/api/wallet/context?address=' + encodeURIComponent(recipient), { cache: 'no-store' });
        await verifyNetwork(ethereum, state, fresh);
        const providerNonce = quantity(await ethereum.request({ method: 'eth_getTransactionCount', params: [recipient, 'pending'] }));
        if (quantity(fresh.nonce) !== transaction.nonce || providerNonce !== transaction.nonce) throw new Error('The wallet transaction nonce changed or does not match this chain. Nothing was sent. Check pending wallet activity, then choose Continue mint.');
        // Simulate the exact transaction on the wallet's RPC, never broadcast a probe.
        await ethereum.request({ method: 'eth_call', params: [{ from: transaction.from, to: transaction.to, data: transaction.data, value: transaction.value }, 'latest'] });
        // Another tab may consume the nonce while simulation is in flight.
        const finalContext = await readJson('/api/wallet/context?address=' + encodeURIComponent(recipient), { cache: 'no-store' });
        await verifyNetwork(ethereum, state, finalContext);
        await walletUnchanged(ethereum, state, recipient, generation);
        const finalNonce = quantity(await ethereum.request({ method: 'eth_getTransactionCount', params: [recipient, 'pending'] }));
        if (quantity(finalContext.nonce) !== transaction.nonce || finalNonce !== transaction.nonce) throw new Error('The wallet transaction nonce changed or does not match this chain. Nothing was sent. Check pending wallet activity, then choose Continue mint.');
        if (stopped || generation !== walletGeneration || !sameAddress(verified, recipient)) throw new Error('The wallet changed during preparation. Connect it again.');
        validateAuthorization(result, state, recipient);
        feedback('Confirm the mint transaction in your wallet.' + (local ? ' Transaction nonce: ' + BigInt(transaction.nonce) + '.' : ''));
        sending = true; storageSet(submissionKey, { uncertain: true, wallet: recipient, mode });
        const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [transaction] });
        if (!hashPattern.test(hash || '')) throw new Error('The wallet returned an invalid transaction hash.');
        setPending(hash, recipient, transaction.nonce);
        try { await boundedCheck(post('/api/mints/report', { code, transactionHash: hash })); }
        catch { reportNeeded = true; feedback('Transaction submitted. Saving its status will retry. Transaction: ' + hash); }
        await inspectSubmission();
      }
      schedule(pollMint);
    } catch (error) {
      const localRejectedBeforeSend = mode === 'local' && ['REQUEST_EXPIRED', 'WALLET_PROOF_REQUIRED', 'NOT_READY', 'CONSENT_REQUIRED', 'CSRF_INVALID', 'CSRF_FAILED', 'SESSION_REQUIRED', 'SESSION_EXPIRED', 'REQUEST_SESSION_MISMATCH', 'MINT_RESERVED', 'CHAIN_CLOCK', 'MINT_UNAVAILABLE', 'MINT_NETWORK_UNAVAILABLE'].includes(error?.code);
      if (sending && !submittedHash && error?.code !== 4001 && error?.code !== 'ACTION_REJECTED' && !localRejectedBeforeSend) {
        uncertainSubmission = true;
        feedback('The wallet response is uncertain. Check wallet activity before any retry. This page will check for a confirmed mint.'); schedule(pollMint);
      } else {
        if (!submittedHash) storageRemove(submissionKey);
        feedback(errorText(error));
        if (['ALREADY_MINTED', 'HANDLE_ALREADY_MINTED', 'TOKEN_ALREADY_MINTED'].includes(error?.code)) {
          page.dataset.mintState = 'pending'; schedule(pollMint, 100);
        }
      }
    } finally { mintBusy = false; updateButtons(); }
  };
  const resumeIntent = async () => {
    const intent = storageGet(intentKey);
    if (!intent || page?.dataset.assessmentState !== 'ready') return;
    storageRemove(intentKey);
    const state = await session();
    if (intent.code !== code || intent.handle !== handle || String(intent.tokenId) !== tokenId || !sameAddress(intent.wallet, verified) || intent.mode !== walletMode || intent.chain !== expectedChain(state) || !sameAddress(intent.contract, root.dataset.contract) || !Number.isFinite(intent.expiresAt) || intent.expiresAt <= Date.now()) { feedback('Choose Continue mint when you are ready.'); return; }
    await submitMint(intent.mode);
  };
  const pollAssessment = async () => {
    if (stopped || !code) return;
    try {
      const result = await readJson('/api/assessments/' + encodeURIComponent(code));
      const state = result.assessment || result;
      if (state.handle !== handle || String(state.tokenId) !== tokenId) throw new Error('The prepared request does not match this handle.');
      if (state.mint?.state === 'minted') { reveal(); return; }
      if (state.mint?.state === 'pending') {
        storageRemove(intentKey); page.dataset.mintState = 'pending';
        message('[data-assessment-status]', 'Mint submitted. Waiting to reveal your signature…');
        updateButtons(); schedule(pollMint); return;
      }
      if (state.status === 'failed') { storageRemove(intentKey); page.dataset.assessmentState = 'failed'; message('[data-assessment-status]', 'The assessment could not be completed.'); feedback(state.error || 'Grok could not prepare this signature. No mint transaction was requested.'); updateButtons(); return; }
      if (state.status === 'ready') {
        page.dataset.assessmentState = 'ready'; page.dataset.canMint = String(state.canMint === true); page.dataset.walletProved = String(state.walletProvedForCode === true);
        if (state.walletProvedForCode !== true) invalidateWallet();
        const form = one('[data-mint-form]'); if (form) form.hidden = false;
        message('[data-assessment-status]', 'Your signature is ready to mint. Approve the transaction in your wallet to reveal it.');
        feedback('Signature prepared. Reveal after minting.'); updateButtons(); await resumeIntent(); return;
      }
      schedule(pollAssessment);
    } catch (error) { if (!stopped) { message('[data-poll-feedback]', errorText(error)); schedule(pollAssessment, 8000); } }
  };
  all('[data-assessment-request]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!verified || walletBusy || mintBusy || requestBusy) { message('[data-request-feedback]', 'Connect and verify your wallet first.'); return; }
    const requestedHandle = (form.querySelector('input[name=handle]')?.value || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(requestedHandle)) { message('[data-request-feedback]', 'Enter an X handle with 1–15 letters, numbers, or underscores.'); return; }
    requestBusy = true; updateButtons();
    const recipient = verified, mode = walletMode, generation = walletGeneration;
    message('[data-request-feedback]', 'Grok is preparing your signature. Your wallet will ask you to mint when it is ready.');
    try {
      const state = await session();
      if (mode === 'injected') {
        const ethereum = provider(); await ensureChain(ethereum, state);
        await walletUnchanged(ethereum, state, recipient, generation);
      }
      const result = await post('/api/assessments', { handle: requestedHandle }, () => {
        if (stopped || generation !== walletGeneration || !sameAddress(verified, recipient) || walletMode !== mode) throw new Error('The wallet changed. Connect it again before preparing a signature.');
      });
      const url = new URL(result.url, location.origin);
      if (url.origin !== location.origin || !codePattern.test(result.code || '') || url.pathname !== '/mint/' + result.code || url.search || url.hash || result.handle !== requestedHandle.toLowerCase() || !/^\d+$/.test(String(result.tokenId))) throw new Error('The assessment returned an invalid result link.');
      if (!sameAddress(verified, recipient) || walletMode !== mode || stopped) throw new Error('The wallet changed. Open the prepared request to continue.');
      storageSet('intent:' + result.code, { code: result.code, handle: result.handle, tokenId: String(result.tokenId), wallet: recipient, mode, chain: expectedChain(state), contract: root.dataset.contract, expiresAt: Date.now() + 10 * 60 * 1000 });
      location.assign(url.pathname);
    } catch (error) {
      if (error?.code === 'ALREADY_MINTED' && typeof error.url === 'string' && error.url === '/signatures/' + requestedHandle.toLowerCase()) location.assign(error.url);
      else message('[data-request-feedback]', errorText(error));
    } finally { requestBusy = false; updateButtons(); }
  }));
  all('[data-connect-wallet]').forEach((button) => button.addEventListener('click', async () => {
    if (walletBusy || mintBusy || requestBusy || submittedHash || uncertainSubmission) return;
    walletBusy = true; button.disabled = true; invalidateWallet();
    try {
      const ethereum = provider(), state = await session();
      feedback('Choose your wallet…');
      const address = (await ethereum.request({ method: 'eth_requestAccounts' }))?.[0];
      if (!addressPattern.test(address || '')) throw new Error('The wallet returned no valid address.');
      await ensureChain(ethereum, state);
      const generation = walletGeneration;
      await walletUnchanged(ethereum, state, address, generation, false);
      const proof = await post('/api/wallet/challenge', { address, ...(code ? { code } : {}) });
      if (!proof.challengeId || typeof proof.message !== 'string' || !proof.message || (proof.address && !sameAddress(proof.address, address)) || (proof.code && proof.code !== code)) throw new Error('The wallet proof does not match this request. Nothing was signed.');
      await ensureChain(ethereum, state);
      await walletUnchanged(ethereum, state, address, generation, false);
      feedback('Sign the one-time message to verify your wallet. This does not send a transaction.');
      const signature = await ethereum.request({ method: 'personal_sign', params: [proof.message, address] });
      await walletUnchanged(ethereum, state, address, generation, false);
      const result = await post('/api/wallet/verify', { challengeId: proof.challengeId, signature });
      if (!sameAddress(walletAddress(result), address)) throw new Error('The verified wallet does not match the selected account.');
      await walletUnchanged(ethereum, state, address, generation, false);
      walletReady(address, state, 'injected');
      if (one('[data-collection-page]')) { location.reload(); return; }
      feedback('Wallet connected. Choose Mint & reveal when ready.');
    } catch (error) { invalidateWallet(); feedback(errorText(error)); }
    finally { walletBusy = false; button.disabled = false; updateButtons(); }
  }));
  one('[data-mint-form]')?.addEventListener('submit', async (event) => { event.preventDefault(); await submitMint('injected'); });
  if (local) {
    one('[data-dev-wallet]')?.addEventListener('click', async (event) => {
      if (walletBusy || mintBusy || requestBusy || submittedHash || uncertainSubmission) return;
      const button = event.currentTarget;
      walletBusy = true; button.disabled = true; invalidateWallet();
      try {
        const state = await session();
        if (expectedChain(state) !== '0x7a69') throw new Error('The local test wallet is available only on chain 31337.');
        const result = await post('/api/dev/wallet', code ? { code } : {});
        walletReady(walletAddress(result), state, 'local');
        if (one('[data-collection-page]')) { location.reload(); return; }
        message('[data-dev-feedback]', 'Local test wallet connected. Mint & reveal uses this isolated test chain.'); feedback('Local test wallet connected.');
      } catch (error) { message('[data-dev-feedback]', errorText(error)); }
      finally { walletBusy = false; button.disabled = false; updateButtons(); }
    });
    one('[data-dev-mint]')?.addEventListener('click', async () => submitMint('local'));
  }
  one('[data-copy-handoff]')?.addEventListener('click', async () => {
    const field = one('[data-handoff-prompt]'); if (!field) return;
    try { await navigator.clipboard.writeText(field.value); message('[data-copy-feedback]', 'Copied. Paste it into Grok.'); }
    catch { field.focus(); field.select(); message('[data-copy-feedback]', 'Select and copy the prompt above.'); }
  });
  one('[data-disconnect-wallet]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled || mintBusy || requestBusy) return;
    button.disabled = true;
    try { await post('/api/session/logout', {}); invalidateWallet(); location.reload(); }
    catch (error) { feedback(errorText(error)); button.disabled = false; }
  });
  const onAccounts = () => { if (walletBusy) walletGeneration++; else { invalidateWallet(); feedback('The wallet account changed. Connect it again before continuing.'); } };
  const onChain = () => { if (walletBusy) walletGeneration++; else { invalidateWallet(); feedback('The wallet network changed. Connect it again before continuing.'); } };
  window.ethereum?.on?.('accountsChanged', onAccounts);
  window.ethereum?.on?.('chainChanged', onChain);
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); abort.abort(); window.ethereum?.removeListener?.('accountsChanged', onAccounts); window.ethereum?.removeListener?.('chainChanged', onChain); }, { once: true });
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
  const boot = async () => {
    if (!page && !one('[data-assessment-request]')) return;
    try {
      const state = await session(); if (stopped) return;
      const savedMode = storageGet('wallet-mode');
      if (state.walletVerified === true || page?.dataset.walletProved === 'true') walletReady(walletAddress(state), state, local && savedMode?.mode === 'local' && sameAddress(savedMode.address, walletAddress(state)) ? 'local' : 'injected');
      const submission = code ? storageGet(submissionKey) : null;
      if (submission && (hashPattern.test(submission.hash || '') || submission.uncertain === true)) {
        if (hashPattern.test(submission.hash || '')) {
          submittedHash = submission.hash; reportNeeded = true;
          submittedWallet = addressPattern.test(submission.wallet || '') ? submission.wallet : walletAddress(state);
          submittedAt = Number.isFinite(submission.submittedAt) && submission.submittedAt > 0 && submission.submittedAt <= Date.now() ? submission.submittedAt : Date.now();
          expectedNonce = isQuantity(submission.expectedNonce) ? submission.expectedNonce : null;
          storageSet(submissionKey, { ...submission, submittedAt });
          page.dataset.mintState = 'pending';
          message('[data-assessment-status]', 'Mint submitted. Waiting to reveal your signature…');
        } else uncertainSubmission = true;
        walletMode = local && submission.mode === 'local' ? 'local' : 'injected';
        feedback(submittedHash ? 'Checking your submitted transaction before revealing.' : 'Check wallet activity. This page is checking for a confirmed mint before any retry.');
        storageRemove(intentKey); updateButtons(); schedule(pollMint, 100); return;
      }
      if (page?.dataset.mintState === 'minted') { reveal(); return; }
      if (page?.dataset.mintState === 'pending') { schedule(pollMint, 1500); return; }
      if (page?.dataset.assessmentState === 'pending') schedule(pollAssessment, 1500);
      else if (page?.dataset.assessmentState === 'ready') await resumeIntent();
    } catch (error) { if (!stopped) feedback(errorText(error)); }
  };
  updateButtons(); void boot();
})();`;
