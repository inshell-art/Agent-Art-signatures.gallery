# Sale design for signatures.gallery

Research cutoff: 5 September 2026  
Decision scope: first and secondary sales of the transferable one-of-one ERC-721 created by signatures.gallery  
Status: product and architecture proposal; not part of the current V2 contract

## Recommendation

Keep the current V2 release **sale-free**. This proposal does not authorize commerce. After the Stage A rights, legal, marketplace-security, and operating gates are passed, an Agent Art-designated **Commerce Release Authority** must be named and record a separate written pilot decision. Only then should a pilot begin with **not for sale by default**, **collector offers**, and **holder-set fixed prices**. Each later stage needs its own evidence and fresh written release decision. Do not auction every signature and do not sell at mint.

Use a **public-reserve English auction with a soft close** only when a holder deliberately chooses price discovery and there is evidence of real competition. Do not use a Dutch auction for a unique signature. Do not use collection-wide floors, serial price coupling, trade rewards, fractionalization, or price-based reputation ranks.

The strongest first collector-sale experience is not unrestricted “first wallet wins.” It is a **patron offer**: a collector makes a time-limited offer and the current token holder decides whether to accept it. When claimant and holder are the same person, this preserves the claimant’s agency around an identity-linked work. After a transfer, the claimant has no sale veto under V2. The mechanism still gives the market a way to express demand without turning every claimant into a public auction result.

The current V2 decision remains correct: claim and mint are free, explicit, and separate from sale. V2’s nonpayable mint contract should not be modified to collect sale payments. Commerce belongs in a later, separately reviewed layer, preferably using an established marketplace protocol rather than a new custody or auction contract.

## Why this work is not an ordinary NFT drop

A signature contains three things that must not be collapsed:

1. **An irreversible chain record plus retained project provenance.** A controller authenticated as a particular X account claimed a deterministic artwork made from its historical handle and `gr0k`; the project exposes an opaque account reference rather than the provider ID. Mint commitments remain onchain. Project presentation may be suppressed, and offchain availability depends on storage and pin retention.
2. **A transferable token tied to one artifact.** The ERC-721 identifies the particular minted work. Its current holder can change; what copyright or display license accompanies it must be defined separately.
3. **A temporary sale instruction.** A listing, offer, or auction expresses what a holder is willing to do now. It is neither provenance nor credit.

This matches the V2 vocabulary: claimant, initial mint wallet, and current token holder are different roles. A transfer changes current token custody, not claimant credit or historical mint facts. While the project publishes the signature, it remains grouped under the claimant even after the token moves; V2 suppression can later remove it from ordinary project presentation without erasing chain events.

That distinction matters because identity credentials and bearer property behave differently. The W3C Verifiable Credentials model separates issuer, subject, and holder, and explicitly notes that a holder is not always the subject ([W3C VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)). signatures.gallery should use the same conceptual discipline without claiming that its NFT is a W3C credential:

- `Claimed by @handle` is a historical provenance assertion.
- `Initially minted to 0x…` is a mint fact.
- `Currently held by 0x…` is a mutable chain fact.
- `For sale by 0x…` is a revocable market instruction.

The token is therefore transferable and can be sold, but neither public credit nor undefined intellectual-property rights are bearer-owned. The buyer does not become the claimant, signer, artist, or endorsed representative.

This is also the right fit for Agent Art. Agent participation is the invariant; it does not by itself prescribe authorship or ownership ([Agent Art](https://inshell.art/docs/agent-art)). The sale mechanism should expose its own boundary rather than silently redefining the work.

## Direct comparison

Scores are 1–5 and reflect this project’s priorities, not a universal market ranking.

| Mechanism | Preserves meaning | Works with thin demand | Discovers price | Resists speed/bot advantage | Buyer clarity | Recommendation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Not for sale + holder-accepted offers | 5 | 5 | 3 | 4 | 4 | Default |
| Time-limited fixed price, public FCFS | 4 | 5 | 2 | 2 | 5 | Optional, not launch centerpiece |
| Public-reserve English auction + soft close | 3 | 2 | 5 | 4 | 4 | Exceptional, demand-proven works |
| Dutch auction | 2 | 3 | 4 | 2 | 3 | Reject for one-of-one signatures |
| Sealed/Vickrey auction | 3 | 2 | 5 in theory | 3 | 2 | Defer; too much protocol and UX risk |
| Collection-wide floor or serial price curve | 1 | 3 | 2 | 2 | 3 | Reject |

### Why offers and fixed price lead

Posted prices trade some price discovery for speed and convenience. A large matched-listing study of eBay describes the core choice as competitive price discovery versus convenience and found that auctions were more likely to sell but, conditional on sale, often produced lower prices in its 2003–2009 data ([Einav, Farronato, Levin, and Sundaresan, 2018](https://web.stanford.edu/~leinav/pubs/JPE2018.pdf)). That evidence is not about blockchain art and should not be treated as a revenue forecast, but the operational trade-off applies.

For signatures.gallery, demand will be extremely uneven. A known public figure may attract several collectors; most accounts may attract one collector or none. A scheduled auction without multiple serious bidders does not discover a meaningful value. It produces a public no-bid event or a low clearing price that viewers may incorrectly read as a score of the person.

Offers work better with thin, asynchronous demand. Current art-market interfaces already distinguish open offers, list prices, and auctions; SuperRare describes offers as a way for collectors to signal interest even when a work was not intended for sale ([SuperRare](https://help.superrare.com/en/articles/10629742-offers-auctions-and-pricing)). A holder can ignore, reject, or accept an offer without staging their identity as a countdown spectacle.

Pure public fixed-price FCFS has one important defect: if a signature is underpriced and highly anticipated, block ordering and automation decide the winner. Art Blocks rates unrestricted set-price minting as having no price discovery and low bot resistance, while allowlisted fixed price is much more bot-resistant ([Art Blocks minter reference](https://docs.artblocks.io/developer/minter-suite/minters/)). Ethereum’s MEV literature documents searchers competing for transaction ordering ([ethereum.org](https://ethereum.org/developers/docs/mev)). For this reason, a holder-accepted offer or buyer-reserved fixed-price order is better than an announced first-come drop.

### When an English auction is justified

An ascending auction is appropriate when all of the following are true:

- the holder explicitly wants price discovery;
- at least three independent collectors have shown credible interest;
- the reserve is acceptable to the seller and visible before the first bid;
- the current high bid stays locked once the live auction starts; outbid funds are immediately withdrawable or refundable;
- bids near the end extend the close;
- the official interface refuses bids from known issuer, team, seller-controlled, and declared related wallets, while clearly admitting that it cannot identify every sybil or block external bids.

English bidding exposes competing information as the auction progresses, which is useful for idiosyncratic art whose value is uncertain and partly shared among bidders. Classic auction theory associates ascending auctions with information revelation in affiliated-value settings ([Milgrom and Weber’s publications](https://web.stanford.edu/~milgrom/publishedarticles/articlesmain.htm)). This does **not** make the outcome culturally fair: it allocates to willingness and ability to pay, not to the best steward or strongest relationship with the claimant.

Use a 24-hour countdown after the reserve is met and extend the end to 15 minutes after every bid placed in the final 15 minutes. This is legible and already familiar in production art markets; SuperRare uses the same anti-sniping shape ([SuperRare auction mechanics](https://help.superrare.com/en/articles/10629742-offers-auctions-and-pricing)). The extension reduces last-second exclusion. It does not prevent shill bidding, collusion, sybils, or wealth concentration.

### Why not Dutch or sealed bid

A Dutch auction is most defensible for many interchangeable or related units when settlement lets every winner pay the same final price. Art Blocks’ settlement design refunds early buyers down to the final sellout price ([Art Blocks](https://docs.artblocks.io/developer/minter-suite/minters/)). With exactly one signature and one winner, that benefit disappears: allocation becomes “the first person willing and fast enough to accept the descending price.” The clock becomes more visible than the relationship between claimant, Agent, and artifact. It would also import Pulse’s formal language into a work with a different structure.

Pulse is serial: one current ask, one next `$PATH`, and each sale establishes conditions for the following epoch ([Pulse](https://inshell.art/docs/pulse)). Signatures are parallel, person-specific one-of-ones. Coupling one person’s sale to the next person’s price would make their reputations economically interdependent and obscure the signature mechanism. It also cuts against ESMA’s current guidance, which treats a common trading price and interdependent collection values as indicators relevant to whether tokens are genuinely unique ([ESMA NFT classification guidance, pp. 46–47](https://www.esma.europa.eu/sites/default/files/2024-12/ESMA75453128700-1323_Final_Report_Guidelines_on_the_conditions_and_criteria_for_the_qualification_of_CAs_as_FIs.pdf)).

A sealed second-price auction can elicit truthful bids under narrow assumptions, but a credible on-chain version needs commitments, deposits, non-reveal penalties, censorship resistance, privacy decisions, and an auctioneer that cannot manipulate the second bid. EIP-712 helps people inspect structured signatures but provides no replay protection by itself ([EIP-712](https://eips.ethereum.org/EIPS/eip-712)). This is too much new surface for the first commerce release.

## Proposed product model

### State dimensions

Market information is not one enum. A token can have several offers, a listing, prior sales, and an integrity flag at the same time. Keep these dimensions separate:

- **Publication:** published or project-suppressed. Suppression is the outer fence for every ordinary project commerce surface, API, cache, sitemap, deep link, notification, and aggregate. Unavoidable chain facts may still exist independently.
- **Holder sale setting:** not for sale (default), open to offers, public fixed price, buyer-reserved fixed price, or reserve-auction configured. This mutable project preference is changed only through current-holder wallet authentication, is keyed by chain/contract/token plus the holder and ownership epoch, and automatically returns to not for sale when ownership changes.
- **Orders:** zero or more independently expiring offers and at most one project-generated active seller listing. External orders may coexist and must never be silently presented as exhaustive.
- **Auction lifecycle:** configured, live, settlement pending, finalized, cancelled, or failed.
- **Finalized sale history:** an append-only sequence of independently validated market events; “sold” is history, not a current listing state.
- **Integrity:** clean, provisional, or disputed, with a reason and analytics-inclusion decision.

Never show a collection-wide “floor price.” Never rank claimants by price, volume, number of bids, or appreciation. Price is part of the artifact’s custody history, not a measurement of the person, Grok’s participation, or artistic quality.

### Core flow

1. The X account controller claims the signature through X authentication and becomes the claimant of record.
2. The claimant links an EOA, reviews exact content, consents to permanence, and mints for no project mint fee.
3. After finality, the project UI labels the work **Not for sale** and withholds its own listing controls for 72 hours. This is a project-interface cooling-off period, not a token lock: standard ERC-721 transfers, approvals, and external listings remain possible immediately.
4. After that UI delay, the current holder may enable offers, set a fixed price, or—if eligible—configure a reserve auction. The claimant has no separate veto if no longer the holder.
5. Before any project-generated signature request or project-controlled outbound fulfillment handoff, show token, chain, contract, token ID, gross price, currency, gas responsibility, every known fee recipient, net seller proceeds, expiration, and rights statement. A third-party venue must be checked again at its own final confirmation; the project cannot guarantee that external UI.
6. A sale becomes public on signatures.gallery only after the marketplace transaction reaches the project’s finality threshold.

Do not combine “Mint” and “List for sale.” The claimant must never discover after signing a mint transaction that a listing or approval was bundled into it.

### Offer flow

Use WETH or another explicit ERC-20 for funded offers, because a revocable off-chain order cannot escrow native ETH by itself. Each offer must be token-specific, chain-specific, contract-specific, nonce-protected, and expiring. The seller sees:

- offer amount and current fiat estimate timestamp;
- bidder wallet and any declared collector profile;
- marketplace and project fees;
- exact net proceeds;
- expiration and cancellation state;
- a warning if the bidder is linked by project heuristics to the seller, issuer, or prior holders.

An optional collector note may be useful for patronage, but it must remain off-chain, separately consented, length-limited, untrusted, and excluded from token metadata. Acceptance must depend only on the signed economic order; the prose is not a contractual promise.

### Fixed-price flow

Support two variants:

- **Public fixed price** for ordinary listings.
- **Reserved fixed price** for one named wallet after a negotiated or selected patron offer.

Default duration: seven days. Minimum duration: one hour. Maximum duration: 30 days for the official interface. The current holder can cancel before fulfillment. Revocation of approval, nonce cancellation, or expiration invalidates the order under the selected protocol. A transfer normally makes a maker’s order unfulfillable while that maker is not the owner, but the order may revive if the maker reacquires the token before nonce cancellation or expiry. The project invalidates its own holder preference on every ownership epoch and prompts explicit protocol cancellation; it must not claim that transfer alone permanently cancels an external signed order.

The reserved variant is the preferred first collector-sale route when the claimant is still the holder and cares who becomes the first collector. It avoids both an opaque off-platform transfer and an FCFS race. If the claimant is no longer the holder, only the holder controls the order.

### Auction flow

Recommended parameters:

| Parameter | Proposal |
| --- | --- |
| Format | Ascending public-reserve English auction |
| Trigger | First valid bid at or above public reserve |
| Duration after trigger | 24 hours |
| Minimum increment | `max(5% of high bid, chain-specific dust floor)` |
| Soft close | Any bid in final 15 minutes resets remaining time to 15 minutes |
| Cancellation | Allowed before first valid bid only |
| Bid withdrawal | Not while high bid; outbid funds immediately withdrawable/refundable |
| Settlement | Permissionless after close; atomic payment and ERC-721 transfer |
| Currency | WETH initially; add alternatives only after separate review |
| Related parties | Official UI rejects known seller, issuer, team, and controlled/declared related wallets; heuristics flag other links but cannot guarantee exclusion |

Do not gate an auction by follower count or prior token price. Eligibility should be based on observed independent demand—such as three funded offers from wallets that do not appear related—not on social popularity.

## Economics and proceeds

### Pilot recommendation

- Mint price: **0**; claimant pays network gas.
- Project mint fee: **0**.
- Official-market secondary royalty: **0 required by the token contract**.
- External marketplace fee: shown exactly at confirmation and treated as mutable vendor policy.
- Agent Art support: an optional, explicit contribution or an official-interface service share only after legal review and a separate written decision by the named Commerce Release Authority.

Do not retrofit transfer restrictions or royalty enforcement into the current V2 contract. ERC-2981 only signals royalty information; it cannot force payment because a transfer does not prove a sale ([EIP-2981](https://eips.ethereum.org/EIPS/eip-2981)). OpenSea’s current policy likewise makes creator earnings optional for a non-upgradeable custom contract that lacks its enforcement interface, and enforcement limits compatible marketplaces ([OpenSea creator earnings, 20 January 2026](https://support.opensea.io/en/articles/8867026-how-do-i-set-creator-earnings-on-opensea)).

If Agent Art later needs a sustainable sale share, make it legible rather than calling it a universal royalty:

- **External pilot:** no Agent Art transaction fee; the external venue’s disclosed fees apply.
- **Later official-interface executions:** consider a project service share of at most 2.5% of the displayed gross sale consideration, only after rights, tax, consumer-law, and entity review. Seller net equals gross sale consideration minus the project share and every seller-funded marketplace/protocol fee. If any fee is charged to the buyer on top, label a separate buyer total. Apply the project share uniformly to executions through that interface—never infer a special “primary” fee from transfer history.
- **No hidden spread, dynamic claimant fee, follower-based fee, or price-dependent fee.**

The 2.5% ceiling is a governance recommendation, not a fact or authorization. Contemporary venues vary substantially: SuperRare documents 85% to the artist on primary sales and 10% artist royalties on secondary sales ([SuperRare, March 2025](https://help.superrare.com/en/articles/10629742-offers-auctions-and-pricing)); OpenSea currently states a typical 1% NFT-sale fee and 10% primary-drop fee, while warning that prices can change ([OpenSea fees, 12 May 2026](https://support.opensea.io/en/articles/8867091-what-fees-do-i-pay-on-opensea)). The project should choose any fee from its own role model and real costs, not copy a marketplace norm.

### Who may initiate a sale

The project interface may let a wallet sign a listing or accept an offer only when the finalized projection identifies it as current holder and a fresh chain check agrees. That is an interface safety gate, not a restriction on standard ERC-721 transfer rights. The holder’s first project-generated listing should also require a one-time versioned acknowledgement that:

- claimant credit and historical mint commitments do not transfer; continued project publication can be suppressed and third-party content availability is not guaranteed;
- the buyer does not acquire the X account or an endorsement;
- the seller has reviewed the rights license;
- sale and wallet events are public and irreversible at the chain layer once finalized, while project presentation can be suppressed;
- the sale can expose a price that observers may associate with the claimant.

If the current holder is no longer the claimant, the claimant cannot veto an ordinary transfer under V2. The UI must therefore say “Listed by current token holder,” never “Sold by @handle,” unless those facts are independently the same.

## Rights and reputation boundary

Every sale confirmation and public token page should state, in plain language:

> You are buying the transferable token for this specific artwork. You are not buying or controlling the claimant’s X account, identity, name, reputation, authorship, endorsement, signature authority, copyright, trademark, or right of publicity. Ownership does not authorize you to sign for, impersonate, advertise as, or imply approval by the claimant, Grok, Agent Art, or the artist.

The project needs a documented rights chain and a versioned license before even the external commerce pilot launches. It must identify the system artist, any participating Agent/Grok contribution, claimant permissions, the actual copyright owner or owners, the party authorized to license the work, and the rights—if any—that travel with the token. Until those questions are signed off, the site must not say that Agent Art, the claimant, or the holder owns or licenses the artwork.

V2 mint consent did not authorize later project-hosted commerce presentation. Add a separate, versioned **commerce-presentation consent** controlled by the claimant. For already-minted works, collect it before signatures.gallery shows offers, prices, outbound marketplace links, or sale analytics beside that claimant’s work. For later mints, keep it a separate optional step rather than bundling it into mint. Revoking it hides project commerce presentation but cannot cancel a holder’s ERC-721 transfer or external listing. If consent is absent or the claimant is unreachable, the project remains “not for sale” on its own surfaces even though external token activity may exist.

Counsel and the identified rightsholder could evaluate this conservative buyer-license scope; it is a placeholder, not a current grant:

- personal display and resale of the lawfully acquired token;
- no commercial endorsement use;
- no use as an authentication mark or legal signature;
- no alteration presented as the claimant’s authentic signature;
- the identified licensor retains all copyright not expressly granted;
- claimant retains identity, name, handle, personality, and endorsement rights;
- the license travels with the token only to the limited extent expressly stated.

The U.S. Copyright Office and USPTO found widespread concern that NFT buyers and sellers do not understand what IP rights are implicated and recommended transparency and consumer education rather than new IP law ([joint NFT study, 2024](https://www.copyright.gov/policy/nft-study/)). WIPO similarly warns that buying an NFT normally does not transfer the underlying work or its copyright ([WIPO](https://www.wipo.int/en/web/wipo-magazine/articles/non-fungible-tokens-nfts-and-copyright-42365)). This project has an extra identity/endorsement risk, so a generic marketplace footer is insufficient.

## Market integrity

Public reputation makes manipulation more damaging than ordinary collectible wash volume. Historical NFT data shows concentrated and path-dependent markets: one study of 6.1 million trades found only about 20% of assets had a secondary sale, while prior sale history was a strong price predictor ([Nadini et al., 2021](https://www.nature.com/articles/s41598-021-00053-8)). A six-gallery NFT-art study found the top 10% of sellers and buyers controlled 86% and 92% of dollar volume in its sample ([Franceschet et al., 2023](https://www.frontiersin.org/journals/blockchain/articles/10.3389/fbloc.2022.1073499/full)). These historical samples are not a forecast for signatures.gallery, but they make “the market price equals public worth” indefensible.

Required controls:

- no trading rewards, points, fee rebates tied to volume, or “most traded” badges;
- no claimant price leaderboard, collection floor, appreciation chart, or rarity rank;
- flag direct self-trades, short wallet cycles, same-funder clusters, rapid back-and-forth transfers, extreme price jumps, and issuer/team involvement;
- retain the immutable chain event but exclude flagged transactions from project aggregates;
- label heuristics as signals, not proof of misconduct;
- refuse known issuer/team/seller/declared-related bids in the official interface, disclose known participation seen externally, and state that sybil detection is heuristic rather than prevention;
- rate-limit off-chain offers and require funded balances/allowances before ranking them;
- use finality-gated sale state and recompute provisional ownership after reorgs;
- provide a report path for compromised wallets, phishing, impersonation, and rights disputes.

The wash-trading literature finds that marketplace token rewards can make manipulation unusually profitable ([von Wachter et al., “A Game of NFTs,” 2023](https://arxiv.org/abs/2212.01225)). That is a strong reason to avoid trade incentives entirely.

## Regulatory posture

This section is risk framing, not legal advice. The operating entity, seller, buyer, custody model, payment assets, sanctions exposure, tax residence, and countries served are not yet specified, so qualified counsel must classify the actual launch.

The product should preserve the strongest available facts:

- each token corresponds to a separately claimed, deterministic, account-specific artifact;
- there is no fractional interest;
- there is no revenue share, yield, staking return, buyback, price support, or promise of appreciation;
- marketing describes art, provenance, collection, and patronage—not investment;
- no collection-wide price mechanism makes signatures economically interchangeable;
- the platform does not custody user assets or promise execution at a quoted fiat value;
- fees, rights, seller, and counterparty are disclosed before signature.

As of the research cutoff, the SEC describes digital collectibles as assets designed to be collected or used that may represent artwork, while warning that fractional interests may be securities; it also states that a non-security crypto asset can still be offered as part of an investment contract depending on the transaction ([SEC guidance, updated 15 May 2026](https://www.sec.gov/resources-small-businesses/capital-raising-building-blocks/crypto-assets-federal-securities-laws)). In the EU, MiCA Article 2 excludes crypto-assets that are unique and non-fungible, but ESMA says economic substance and distinct characteristics matter more than merely assigning an ERC-721 identifier; fractionalization and common collection pricing weaken the uniqueness analysis ([MiCA Article 2](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-2-scope), [ESMA guidance](https://www.esma.europa.eu/sites/default/files/2024-12/ESMA75453128700-1323_Final_Report_Guidelines_on_the_conditions_and_criteria_for_the_qualification_of_CAs_as_FIs.pdf)).

Before production sales, counsel should review at minimum: securities/financial-instrument classification, marketplace or broker obligations, AML/sanctions duties, consumer cancellation and unfair-practice rules, tax reporting, privacy, copyright/license chain, trademarks, publicity/personality rights, and auction law in every served jurisdiction.

## Technical architecture

### Phase 1: external protocol, project-native context

Keep `GalleryOfSignatures` unchanged. It already exposes standard ERC-721 ownership, approvals, and transfers, which lets third-party brokers and auction applications operate without changing token provenance ([ERC-721](https://eips.ethereum.org/EIPS/eip-721)).

For the pilot:

- store the holder’s opt-in in a mutable project `market_preferences` record keyed by chain, contract, token, holder, and ownership epoch; require current-holder wallet authentication to enable it and invalidate it automatically on transfer;
- require both current-holder opt-in and the claimant’s separate commerce-presentation consent before displaying “View/offer on marketplace” or project-indexed open offers from the signature page. External venues may still accept unsolicited offers, but the project neither claims to prevent them nor surfaces them while either project permission is absent;
- insert a project-controlled preflight before every outbound listing, acceptance, or fulfillment handoff. Show the project’s freshly validated facts and warn users to compare them with the third-party venue’s final transaction; external confirmation remains outside project control;
- ingest only allowlisted marketplace contracts and frozen event ABIs;
- show project-native claimant/initial-minter/current-holder context around the external order;
- require the user to complete listings and acceptance in the marketplace UI;
- do not custody keys, WETH, ETH, or NFTs;
- do not call an order “verified” merely because an API returned it—validate chain, contract, token, maker, ownership, approvals, nonce, expiration, currency, and consideration independently.
- inherit the V2 signature-publication fence: if a signature is suppressed, omit ordinary sale links, offers, listings, notifications, analytics, sitemaps, and caches even though unavoidable chain activity may remain independently observable.
- publish an allowlist of marketplace contract, operator, and conduit addresses; explain whether fulfillment needs token-specific `approve` or collection-wide `setApprovalForAll`; show current approvals and a revocation path before sending a holder away.

Seaport is a practical first integration candidate because it represents offers and consideration in signed orders, supports ERC-721 listings/offers, and is already used by OpenSea ([Seaport overview](https://docs.opensea.io/docs/seaport)). OpenSea documents an SDK for listings, offers, fulfillment, and querying through Seaport ([SDK](https://docs.opensea.io/reference/opensea-sdk)). Vendor APIs, fees, moderation, and availability remain dependencies; lock versions and build a kill switch.

Do not call Seaport “risk free” or “the project marketplace.” Perform a separate contract/version review, restrict supported order shapes, simulate fulfillment, and show the exact verifying contract before signature.

### Phase 2: official fixed-price and offer interface

After the external pilot proves demand:

- generate only narrowly constrained marketplace orders;
- use a chain/contract/order-domain allowlist;
- add a project nonce/cancellation view and reconciliation worker;
- index order events and ERC-721 transfers with the same reorg/finality discipline as mint events;
- support public and one-buyer-reserved fixed-price orders;
- make all project fees explicit consideration recipients;
- keep marketplace state in separate tables from immutable claim and mint provenance.
- preserve the holder-authenticated `market_preferences` model; never infer project opt-in merely because an external order exists.
- initially generate token-specific approvals only where the selected protocol supports them. Do not generate `setApprovalForAll` from the project interface without a later, separately reviewed consent design. Holders remain free to grant standard ERC-721 approvals elsewhere.

### Phase 3: optional auction integration

Only after fixed listings and offers demonstrate multiple-bidder demand, integrate one audited auction implementation. Do not write a bespoke auction contract until an existing protocol has been rejected with documented reasons.

The auction integration must specify:

- bid custody/refund mechanics;
- reserve and increment rules;
- block-timestamp semantics;
- soft-close behavior under congestion;
- emergency behavior that cannot seize the NFT or seller proceeds;
- permissionless settlement and recovery of outbid funds;
- reentrancy, fee-on-transfer token, and malicious receiver behavior;
- exact finality and reorg presentation;
- invariant that no sale event can rewrite claimant or mint provenance.

## Test and launch gates

### Contract and order tests

- standard ERC-721 transfer authority remains the onchain current holder or an approved operator, without waiting for project finality;
- the project generates a seller order only after its finalized projection identifies the current holder and a fresh chain check confirms that wallet still owns the token;
- order domain binds chain, marketplace contract, NFT contract, token ID, maker, consideration, nonce, and expiry;
- replay, duplicate fulfillment, stale ownership, revoked approval, nonce cancellation, and expired orders fail;
- public versus reserved buyer behavior is exact;
- displayed gross sale consideration equals seller net proceeds plus every seller-funded fee for all rounding cases; any buyer-funded fee is added to a separately displayed buyer total;
- WETH allowance/balance changes between quote and execution are handled safely;
- transfer before fulfillment makes a stale maker listing unfulfillable while the maker is not owner, invalidates the project ownership epoch, and triggers explicit protocol cancellation; tests also cover possible revival after reacquisition if cancellation did not occur;
- malicious ERC-721 receiver and reentrant settlement paths cannot steal funds or strand unrelated bids;
- same-block sale and transfer ordering resolves deterministically;
- a chain reorg returns the UI to provisional state and never rewrites immutable claimant credit.

### Auction tests

- first valid bid at reserve starts the exact deadline;
- bids below reserve or increment fail;
- every bid in the final 15 minutes resets remaining time to 15 minutes;
- seller cancellation works before first bid and fails after it;
- high bidder cannot withdraw; outbid bidder can recover funds exactly once;
- known team/seller/declared-related wallets are rejected by the official interface; tests and copy never claim this prevents undisclosed sybils or bids submitted elsewhere;
- settlement is permissionless, atomic, idempotent, and safe after long delay;
- congestion, timestamp boundaries, reverted refunds, and contract-paused states have explicit behavior.

### Product tests

- every surface keeps claimant, initial minter, current holder, seller, and buyer distinct;
- “Not for sale” is the initial finalized state;
- mint never grants a marketplace approval or creates an order;
- every project-controlled confirmation or outbound preflight shows gross, known fees, gas responsibility, net, currency, fiat timestamp, expiry, and rights; copy does not promise control over a third-party venue’s screen;
- keyboard, screen-reader, mobile, dark-mode, wrong-chain, rejected-signature, and stale-tab paths work;
- prices are never used to order Gallery or claimant pages;
- flagged market activity remains inspectable but is excluded from aggregates;
- external marketplace outage leaves provenance pages intact.
- a suppressed signature publishes no ordinary market UI, API rows, alerts, cached listings, sitemap entries, or analytics contributions;
- token-specific and collection-wide approvals are distinguished, disclosed before signature, observable afterward, and paired with an exact revocation path.

### Legal and operational gates

- signed-off rights/license text and claimant consent version;
- entity, jurisdictions, sanctions, tax, privacy, and auction-law review;
- published fee schedule and related-wallet policy;
- marketplace contract/version allowlist and incident kill switch;
- phishing copy review and verified-link policy;
- reconciliation, compromise, delisting, rights-dispute, and vendor-outage runbooks;
- independent security review before an official embedded fulfillment flow.

## Rollout and decision metrics

### Stage A — external-commerce pilot

After Stage A rights/license, claimant commerce-presentation consent, marketplace-approval, legal, and operating gates are signed off **and** the named Commerce Release Authority records a separate pilot decision, keep mint free and sales external. Add claimant-consented, holder-opted-in contextual outbound links and observe for 8–12 weeks. This is the “commerce pilot” in this proposal; it is not a project-native order interface.

Measure:

- percentage of finalized holders enabling offers;
- independent funded offers per token;
- time from mint to first offer and first accepted offer;
- offer acceptance rate and median number of bidders;
- support/phishing incidents;
- percentage of trades flagged as related or circular;
- claimant comprehension of “credit does not transfer.”

Do **not** optimize gross volume, floor, or price appreciation.

### Stage B — offers and fixed price

Ship official-interface offers and time-limited fixed listings only if users can understand the rights boundary, the external pilot shows genuine demand, every Stage B gate below passes, and the Commerce Release Authority records a fresh Stage B decision. Prefer reserved fixed-price acceptance for first sales.

Proceed only if:

- at least 90% of usability-test participants correctly identify claimant versus holder;
- no critical order-validation or phishing issue remains;
- fee/net proceeds comprehension meets the same threshold;
- reconciliation agrees with chain ownership and order state at 100% in test/rehearsal windows.

### Stage C — reserve auctions

Add auctions only if a meaningful minority of works repeatedly receive at least three independent funded offers, holders explicitly ask for price discovery, all auction security/legal gates pass, and the Commerce Release Authority records a fresh capped Stage C decision. Start with curated eligibility and publish why each auction is eligible. Reassess after the capped cohort before any expansion.

Stop or roll back auction promotion if no-bid rates are high, related bidding is material, claimants report reputational harm, or viewers read clearing price as an official score.

## Final decision

For signatures.gallery, **offers and fixed price should lead the commerce pilot; auction is an exception**. The present V2 release itself remains sale-free.

More precisely:

- claim and mint remain free and never imply sale;
- every work begins not for sale;
- open offers let demand appear without staging a public failure;
- holder-accepted or buyer-reserved fixed price is the preferred first collector sale;
- public fixed price is optional for holders who value speed over collector selection;
- an anti-sniping English reserve auction is available later for genuinely contested works;
- Dutch, sealed-bid, serial pricing, collection floors, fractionalization, royalties enforced by transfer restriction, and trade incentives are out;
- sales move the token and any expressly documented token license only; claimant credit and provenance do not move. Project presentation can still be suppressed under V2 while irreversible chain facts remain.

This design monetizes voluntary collector custody while refusing to turn a person’s public signature into a platform-issued reputation score.

## Evidence limits

No causal study directly tests a transferable one-of-one that combines a living person’s handle-derived signature, public identity credit, Agent participation, and immutable provenance. The recommendation is therefore an inference from auction theory, conventional and crypto art markets, identity/credential semantics, current marketplace mechanics, market-integrity research, and current U.S./EU regulatory guidance.

Much empirical NFT evidence covers 2017–2022 and markets with different incentives. Marketplace policies are mutable. Regulatory classification is jurisdiction- and fact-specific. These limits strengthen the case for a reversible external-market pilot and a semantic boundary before custom sale infrastructure.
