// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GalleryOfSignatures} from "../src/GalleryOfSignatures.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function deal(address account, uint256 newBalance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function expectPartialRevert(bytes4 revertData) external;
    function getRecordedLogs() external returns (Log[] memory);
    function prank(address msgSender) external;
    function recordLogs() external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}

contract GalleryOfSignaturesHarness is GalleryOfSignatures {
    constructor(
        string memory collectionName_,
        string memory collectionSymbol_,
        string memory collectionURI_,
        bytes32 collectionMetadataSha256_,
        bytes32 collectionURIHash_,
        uint48 defaultAdminDelay_,
        address delayedAdmin_,
        address authorizerManager_,
        address pauser_,
        address authorizationRevoker_,
        address initialAuthorizer_
    )
        GalleryOfSignatures(
            collectionName_,
            collectionSymbol_,
            collectionURI_,
            collectionMetadataSha256_,
            collectionURIHash_,
            defaultAdminDelay_,
            delayedAdmin_,
            authorizerManager_,
            pauser_,
            authorizationRevoker_,
            initialAuthorizer_
        )
    {}

    function authorizationStructHash(MintAuthorization calldata a) external pure returns (bytes32) {
        return hashMintAuthorization(a);
    }

    function authorizationDigest(MintAuthorization calldata a) external view returns (bytes32) {
        return _hashTypedDataV4(hashMintAuthorization(a));
    }

    function seedTokenForAtomicityTest(address owner, uint256 tokenId) external {
        _mint(owner, tokenId);
    }

    function forceCurrentEpochForOverflowTest(uint32 epoch) external {
        currentAuthorizerEpoch = epoch;
    }

    function forceAuthorizerSlotForPopulationTest(uint32 epoch, address authorizer) external {
        authorizerByEpoch[epoch] = authorizer;
    }
}

contract GalleryOfSignaturesTest {
    struct SignatureMintedData {
        uint256 tokenId;
        bytes32 walletBindingId;
        bytes32 svgSha256;
        bytes32 pngSha256;
        bytes32 metadataSha256;
        bytes32 tokenURIHash;
        uint32 authorizerEpoch;
        bytes32 authorizationDigest;
    }

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string private constant COLLECTION_NAME = "Gallery of Signatures";
    string private constant COLLECTION_SYMBOL = "SIGN";
    string private constant COLLECTION_URI = "ipfs://bafybeicollectionfixture/metadata.json";
    string private constant TOKEN_URI = "ipfs://bafybeitokenfixture/metadata.json";

    bytes32 private constant COLLECTION_SHA256 = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
    bytes32 private constant SIGNATURE_DIGEST = 0x4f508de936e884b48051822b94edec1baefeb2aa0781535768ce4aca8a8d93ea;
    bytes32 private constant WALLET_BINDING_ID = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    bytes32 private constant SVG_SHA256 = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 private constant PNG_SHA256 = 0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 private constant METADATA_SHA256 = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 private constant AUTHORIZATION_ID = 0x4444444444444444444444444444444444444444444444444444444444444444;

    bytes32 private constant MINT_TYPEHASH = 0x2693c666060f4281b37daed88fc7538b218d454bb5b4950c96ac1bd9537b64de;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;
    bytes32 private constant TRANSFER_EVENT_SIGNATURE = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant SIGNATURE_MINTED_EVENT_SIGNATURE = keccak256(
        "SignatureMinted(bytes32,bytes32,address,uint256,bytes32,bytes32,bytes32,bytes32,bytes32,uint32,bytes32)"
    );

    uint256 private constant AUTHORIZER_PRIVATE_KEY = 0xA11CE;
    uint256 private constant SECOND_AUTHORIZER_PRIVATE_KEY = 0xB0B;

    address private constant ADMIN = address(0xA001);
    address private constant AUTHORIZER_MANAGER = address(0xA002);
    address private constant PAUSER = address(0xA003);
    address private constant AUTHORIZATION_REVOKER = address(0xA004);
    address private constant MINT_WALLET = address(0xB001);
    address private constant SECOND_WALLET = address(0xB002);
    address private constant ATTACKER = address(0xBAD);

    GalleryOfSignaturesHarness private gallery;
    address private authorizer;

    function setUp() public {
        vm.chainId(11_155_111);
        vm.warp(1_800_000_060);
        authorizer = vm.addr(AUTHORIZER_PRIVATE_KEY);
        gallery = _deploy(authorizer);
    }

    function testConstructorFreezesCollectionAndSeparatesRoles() public view {
        _assertEq(gallery.name(), COLLECTION_NAME, "name");
        _assertEq(gallery.symbol(), COLLECTION_SYMBOL, "symbol");
        _assertEq(gallery.contractURI(), COLLECTION_URI, "contract URI");
        _assertEq(gallery.collectionMetadataSha256(), COLLECTION_SHA256, "collection SHA-256");
        _assertEq(gallery.collectionURIHash(), keccak256(bytes(COLLECTION_URI)), "collection URI hash");
        _assertEq(uint256(gallery.currentAuthorizerEpoch()), 1, "initial epoch");
        _assertEq(gallery.authorizerByEpoch(1), authorizer, "initial authorizer");
        _assertEq(gallery.authorizerByEpoch(0), address(0), "epoch zero absent");
        _assertFalse(gallery.revokedAuthorizerEpoch(1), "initial epoch active");
        _assertEq(gallery.defaultAdmin(), ADMIN, "default admin");
        _assertEq(uint256(gallery.defaultAdminDelay()), 48 hours, "admin delay");
        _assertTrue(gallery.hasRole(gallery.AUTHORIZER_MANAGER_ROLE(), AUTHORIZER_MANAGER), "manager role");
        _assertTrue(gallery.hasRole(gallery.PAUSER_ROLE(), PAUSER), "pauser role");
        _assertTrue(gallery.hasRole(gallery.AUTHORIZATION_REVOKER_ROLE(), AUTHORIZATION_REVOKER), "revoker role");
        _assertFalse(gallery.hasRole(gallery.DEFAULT_ADMIN_ROLE(), address(this)), "deployer retained admin");
        _assertFalse(gallery.hasRole(gallery.PAUSER_ROLE(), address(this)), "deployer retained pauser");
    }

    function testMintAbiAndEventSelectorsAreFrozen() public pure {
        _assertEq(
            bytes32(GalleryOfSignatures.mintAuthorized.selector), bytes32(bytes4(0xf722c561)), "mintAuthorized selector"
        );
        _assertEq(
            GalleryOfSignatures.SignatureMinted.selector,
            0x292299975d9bbcb3075f9491c122ed328521a062efd3ed3eb0e8aeb71589b5ac,
            "SignatureMinted topic"
        );
    }

    function testConstructorRejectsBadCollectionURICommitment() public {
        vm.expectPartialRevert(GalleryOfSignatures.CollectionURIHashMismatch.selector);
        new GalleryOfSignaturesHarness(
            COLLECTION_NAME,
            COLLECTION_SYMBOL,
            COLLECTION_URI,
            COLLECTION_SHA256,
            bytes32(uint256(1)),
            48 hours,
            ADMIN,
            AUTHORIZER_MANAGER,
            PAUSER,
            AUTHORIZATION_REVOKER,
            authorizer
        );
    }

    function testConstructorRejectsZeroAdminAndAuthorizer() public {
        vm.expectRevert();
        new GalleryOfSignaturesHarness(
            COLLECTION_NAME,
            COLLECTION_SYMBOL,
            COLLECTION_URI,
            COLLECTION_SHA256,
            keccak256(bytes(COLLECTION_URI)),
            48 hours,
            address(0),
            AUTHORIZER_MANAGER,
            PAUSER,
            AUTHORIZATION_REVOKER,
            authorizer
        );

        vm.expectRevert(GalleryOfSignatures.ZeroInitialAuthorizer.selector);
        new GalleryOfSignaturesHarness(
            COLLECTION_NAME,
            COLLECTION_SYMBOL,
            COLLECTION_URI,
            COLLECTION_SHA256,
            keccak256(bytes(COLLECTION_URI)),
            48 hours,
            ADMIN,
            AUTHORIZER_MANAGER,
            PAUSER,
            AUTHORIZATION_REVOKER,
            address(0)
        );
    }

    function testV1GoldenDigestIsExactTokenId() public pure {
        uint256 tokenId = uint256(SIGNATURE_DIGEST);
        _assertEq(
            tokenId,
            35_875_042_236_945_302_606_725_603_330_365_055_819_023_759_584_116_837_117_696_243_259_715_701_543_914,
            "big-endian token ID"
        );
    }

    function testCommittedEIP712GoldenFixture() public view {
        GalleryOfSignatures.MintAuthorization memory a = GalleryOfSignatures.MintAuthorization({
            signatureDigest: 0x471fa25b1c5a83446abeee3ac702394c4cf3faa0251a5fbef9ab3a2090139206,
            walletBindingId: 0x1111111111111111111111111111111111111111111111111111111111111111,
            mintWallet: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            svgSha256: 0x937c1e9a625d65e3da278f631ab17dcf42917bcfd31ededd2d37476934891228,
            pngSha256: 0x431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460,
            metadataSha256: 0x8ffb1dc5633374864bb5ecaa53cfa02cefeee47b83c5c676d9c0cac8f152d070,
            tokenURIHash: 0x5697cf5a90f4a1227b021c536b28ccf4e82d844ba10cc5cc27fd8530eb37faf5,
            authorizationId: 0x2222222222222222222222222222222222222222222222222222222222222222,
            validAfter: 1_788_534_000,
            deadline: 1_788_534_900,
            authorizerEpoch: 1
        });

        _assertEq(
            keccak256(
                bytes(
                    "MintAuthorization(bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch)"
                )
            ),
            MINT_TYPEHASH,
            "type hash"
        );

        bytes32 structHash = gallery.authorizationStructHash(a);
        _assertEq(structHash, 0x3f7ea1beb9512ee49088fe7f1f014d981a8194db27f5732d4834826c4c742713, "struct hash");

        bytes32 domainSeparator =
            _domainSeparator("signatures.gallery", "2", 11_155_111, 0x5FbDB2315678afecb367f032d93F642f64180aa3);
        _assertEq(
            domainSeparator, 0xcf2c89b6ff7a60dbfea986aaed7939c89485867a5e582a8d814ef912be7ea067, "domain separator"
        );

        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
        _assertEq(digest, 0xa6dca39e75612b2ce4214e5830fc20516e12e4aa971fbd2f4f835512496e20c3, "digest");

        bytes memory signature =
            hex"ced6034679b460d49ecf68a5ace3b56dc90c1d4d639c74b0fe52469f8815bb5425de9dfe89fe6831275692a982a21bbf9610edf6cb2ec27a30a846b7411e620e1b";
        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(signature);
        _assertEq(uint256(signature.length), 65, "signature length");
        _assertTrue(v == 27 || v == 28, "canonical v");
        _assertTrue(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "low s");
        _assertEq(ecrecover(digest, v, r, s), 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, "fixture signer");
    }

    function testValidAuthorizationMintsExactlyOnceAndEmitsExactProvenance() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes32 digest = gallery.authorizationDigest(a);
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, digest);

        vm.recordLogs();
        vm.prank(MINT_WALLET);
        uint256 tokenId = gallery.mintAuthorized(a, TOKEN_URI, signature);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _assertEq(tokenId, uint256(SIGNATURE_DIGEST), "returned token ID");
        _assertEq(gallery.ownerOf(tokenId), MINT_WALLET, "owner");
        _assertEq(gallery.tokenURI(tokenId), TOKEN_URI, "token URI");
        _assertTrue(gallery.mintedSignature(SIGNATURE_DIGEST), "signature consumed");
        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 1, "authorization redeemed");

        uint256 transferCount;
        uint256 signatureMintedCount;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(gallery) || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == TRANSFER_EVENT_SIGNATURE) {
                ++transferCount;
                _assertEq(logs[i].topics[1], bytes32(0), "Transfer from");
                _assertEq(logs[i].topics[2], _addressTopic(MINT_WALLET), "Transfer to");
                _assertEq(uint256(logs[i].topics[3]), tokenId, "Transfer token ID");
            }
            if (logs[i].topics[0] == SIGNATURE_MINTED_EVENT_SIGNATURE) {
                ++signatureMintedCount;
                _assertSignatureMintedLog(logs[i], tokenId, digest);
            }
        }

        _assertEq(transferCount, 1, "one zero-address Transfer");
        _assertEq(signatureMintedCount, 1, "one SignatureMinted");
    }

    function testWrongSenderDoesNotConsumeAndBoundWalletCanStillMint() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));

        vm.expectRevert(abi.encodeWithSelector(GalleryOfSignatures.WrongMintWallet.selector, MINT_WALLET, ATTACKER));
        vm.prank(ATTACKER);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "authorization still unused");
        _assertFalse(gallery.mintedSignature(SIGNATURE_DIGEST), "signature still unminted");

        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);
        _assertEq(gallery.ownerOf(uint256(SIGNATURE_DIGEST)), MINT_WALLET, "bound wallet minted");
    }

    function testEachSignedFieldMutationInvalidatesOriginalAttestation() public {
        GalleryOfSignatures.MintAuthorization memory original = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(original));
        GalleryOfSignatures.MintAuthorization memory changed;

        changed = _authorization();
        changed.signatureDigest = bytes32(uint256(changed.signatureDigest) ^ 1);
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        changed = _authorization();
        changed.walletBindingId = bytes32(uint256(changed.walletBindingId) ^ 1);
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        changed = _authorization();
        changed.mintWallet = SECOND_WALLET;
        _expectInvalidAttestation(changed, TOKEN_URI, signature, SECOND_WALLET);

        changed = _authorization();
        changed.svgSha256 = bytes32(uint256(changed.svgSha256) ^ 1);
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        changed = _authorization();
        changed.pngSha256 = bytes32(uint256(changed.pngSha256) ^ 1);
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        changed = _authorization();
        changed.metadataSha256 = bytes32(uint256(changed.metadataSha256) ^ 1);
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        string memory changedURI = "ipfs://bafybeidifferent/metadata.json";
        changed = _authorization();
        changed.tokenURIHash = keccak256(bytes(changedURI));
        _expectInvalidAttestation(changed, changedURI, signature, MINT_WALLET);

        changed = _authorization();
        changed.authorizationId = bytes32(uint256(changed.authorizationId) ^ 1);
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        changed = _authorization();
        changed.validAfter += 1;
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        changed = _authorization();
        changed.deadline -= 1;
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        vm.prank(AUTHORIZER_MANAGER);
        gallery.addAuthorizerEpoch(2, authorizer);
        changed = _authorization();
        changed.authorizerEpoch = 2;
        _expectInvalidAttestation(changed, TOKEN_URI, signature, MINT_WALLET);

        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "all mutations rolled back");
        _assertFalse(gallery.mintedSignature(SIGNATURE_DIGEST), "all mutations left signature unminted");
    }

    function testOneByteTokenURIMismatchDoesNotConsume() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));

        vm.expectPartialRevert(GalleryOfSignatures.TokenURIHashMismatch.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, string.concat(TOKEN_URI, "x"), signature);

        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "authorization unused");
        _assertFalse(gallery.mintedSignature(SIGNATURE_DIGEST), "signature unminted");
    }

    function testNonCanonicalAttestationsFailClosedWithoutConsumption() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes32 digest = gallery.authorizationDigest(a);
        bytes memory canonical = _sign(AUTHORIZER_PRIVATE_KEY, digest);
        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(canonical);

        bytes32 compactS = bytes32(uint256(s) | (uint256(v - 27) << 255));
        _expectInvalidAttestation(a, TOKEN_URI, abi.encodePacked(r, compactS), MINT_WALLET);

        uint256 curveOrder = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(curveOrder - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        _expectInvalidAttestation(a, TOKEN_URI, abi.encodePacked(r, highS, flippedV), MINT_WALLET);

        bytes memory zeroV = abi.encodePacked(r, s, uint8(0));
        _expectInvalidAttestation(a, TOKEN_URI, zeroV, MINT_WALLET);
        _expectInvalidAttestation(a, TOKEN_URI, bytes.concat(canonical, hex"00"), MINT_WALLET);

        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "malformed signatures not consumed");
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, canonical);
    }

    function testZeroFieldsAndZeroDigestRules() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        a.mintWallet = address(0);
        vm.expectRevert(GalleryOfSignatures.ZeroMintWallet.selector);
        gallery.mintAuthorized(a, TOKEN_URI, hex"");

        a = _authorization();
        a.walletBindingId = bytes32(0);
        vm.expectRevert(GalleryOfSignatures.ZeroWalletBindingId.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, hex"");

        a = _authorization();
        a.authorizationId = bytes32(0);
        vm.expectRevert(GalleryOfSignatures.ZeroAuthorizationId.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, hex"");

        a = _authorization();
        a.signatureDigest = bytes32(0);
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.prank(MINT_WALLET);
        uint256 tokenId = gallery.mintAuthorized(a, TOKEN_URI, signature);
        _assertEq(tokenId, 0, "zero digest token ID is valid");
        _assertEq(gallery.ownerOf(0), MINT_WALLET, "zero token owner");
    }

    function testEarlyExpiredInvertedAndLongWindowsFail() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        a.validAfter = uint64(block.timestamp + 1);
        a.deadline = a.validAfter + 900;
        vm.expectPartialRevert(GalleryOfSignatures.AuthorizationNotActive.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, hex"");

        a = _authorization();
        a.validAfter = uint64(block.timestamp - 901);
        a.deadline = uint64(block.timestamp - 1);
        vm.expectPartialRevert(GalleryOfSignatures.AuthorizationExpired.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, hex"");

        a = _authorization();
        a.validAfter = uint64(block.timestamp);
        a.deadline = uint64(block.timestamp);
        vm.expectPartialRevert(GalleryOfSignatures.InvalidAuthorizationWindow.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, hex"");

        a = _authorization();
        a.validAfter = uint64(block.timestamp - 60);
        a.deadline = a.validAfter + 1_801;
        vm.expectPartialRevert(GalleryOfSignatures.AuthorizationWindowTooLong.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, hex"");
    }

    function testAuthorizationAndSignatureReplayGuards() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        vm.expectPartialRevert(GalleryOfSignatures.AuthorizationUnavailable.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        a.authorizationId = bytes32(uint256(AUTHORIZATION_ID) + 1);
        signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.expectPartialRevert(GalleryOfSignatures.SignatureAlreadyMinted.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);
    }

    function testCrossChainCrossContractAndWrongVersionReplayFail() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));

        vm.chainId(1);
        _expectInvalidAttestation(a, TOKEN_URI, signature, MINT_WALLET);
        vm.chainId(11_155_111);

        GalleryOfSignaturesHarness otherGallery = _deploy(authorizer);
        vm.expectRevert(GalleryOfSignatures.InvalidGalleryAttestation.selector);
        vm.prank(MINT_WALLET);
        otherGallery.mintAuthorized(a, TOKEN_URI, signature);

        bytes32 wrongVersionDomain = _domainSeparator("signatures.gallery", "3", block.chainid, address(gallery));
        bytes32 wrongVersionDigest =
            keccak256(abi.encodePacked(hex"1901", wrongVersionDomain, gallery.authorizationStructHash(a)));
        bytes memory wrongVersionSignature = _sign(AUTHORIZER_PRIVATE_KEY, wrongVersionDigest);
        _expectInvalidAttestation(a, TOKEN_URI, wrongVersionSignature, MINT_WALLET);
    }

    function testEpochOverlapRotationAndPermanentRevocation() public {
        address secondAuthorizer = vm.addr(SECOND_AUTHORIZER_PRIVATE_KEY);
        vm.prank(AUTHORIZER_MANAGER);
        gallery.addAuthorizerEpoch(2, secondAuthorizer);
        _assertEq(uint256(gallery.currentAuthorizerEpoch()), 2, "current epoch");

        GalleryOfSignatures.MintAuthorization memory oldEpoch = _authorization();
        bytes memory oldSignature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(oldEpoch));
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(oldEpoch, TOKEN_URI, oldSignature);

        GalleryOfSignatures.MintAuthorization memory newEpoch = _authorization();
        newEpoch.signatureDigest = bytes32(uint256(SIGNATURE_DIGEST) + 1);
        newEpoch.authorizationId = bytes32(uint256(AUTHORIZATION_ID) + 1);
        newEpoch.mintWallet = SECOND_WALLET;
        newEpoch.authorizerEpoch = 2;
        bytes memory newSignature = _sign(SECOND_AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(newEpoch));
        vm.prank(SECOND_WALLET);
        gallery.mintAuthorized(newEpoch, TOKEN_URI, newSignature);

        vm.prank(AUTHORIZER_MANAGER);
        gallery.revokeAuthorizerEpoch(1);
        _assertTrue(gallery.revokedAuthorizerEpoch(1), "old epoch revoked");

        GalleryOfSignatures.MintAuthorization memory laterOldEpoch = _authorization();
        laterOldEpoch.signatureDigest = bytes32(uint256(SIGNATURE_DIGEST) + 2);
        laterOldEpoch.authorizationId = bytes32(uint256(AUTHORIZATION_ID) + 2);
        oldSignature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(laterOldEpoch));
        vm.expectPartialRevert(GalleryOfSignatures.RevokedAuthorizerEpoch.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(laterOldEpoch, TOKEN_URI, oldSignature);

        vm.expectPartialRevert(GalleryOfSignatures.AuthorizerEpochAlreadyRevoked.selector);
        vm.prank(AUTHORIZER_MANAGER);
        gallery.revokeAuthorizerEpoch(1);
    }

    function testEpochAdditionRequiresExactNextNonzeroAndCannotOverflow() public {
        vm.expectPartialRevert(GalleryOfSignatures.UnexpectedAuthorizerEpoch.selector);
        vm.prank(AUTHORIZER_MANAGER);
        gallery.addAuthorizerEpoch(3, vm.addr(SECOND_AUTHORIZER_PRIVATE_KEY));

        vm.expectRevert(GalleryOfSignatures.ZeroInitialAuthorizer.selector);
        vm.prank(AUTHORIZER_MANAGER);
        gallery.addAuthorizerEpoch(2, address(0));

        gallery.forceAuthorizerSlotForPopulationTest(2, vm.addr(SECOND_AUTHORIZER_PRIVATE_KEY));
        vm.expectPartialRevert(GalleryOfSignatures.AuthorizerEpochAlreadyPopulated.selector);
        vm.prank(AUTHORIZER_MANAGER);
        gallery.addAuthorizerEpoch(2, authorizer);

        gallery.forceCurrentEpochForOverflowTest(type(uint32).max);
        vm.expectRevert(GalleryOfSignatures.AuthorizerEpochOverflow.selector);
        vm.prank(AUTHORIZER_MANAGER);
        gallery.addAuthorizerEpoch(type(uint32).max, vm.addr(SECOND_AUTHORIZER_PRIVATE_KEY));
    }

    function testExactAuthorizationRevocationIsPermanent() public {
        vm.prank(AUTHORIZATION_REVOKER);
        gallery.revokeAuthorization(AUTHORIZATION_ID);
        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 2, "authorization revoked");

        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.expectPartialRevert(GalleryOfSignatures.AuthorizationUnavailable.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        vm.expectPartialRevert(GalleryOfSignatures.AuthorizationUnavailable.selector);
        vm.prank(AUTHORIZATION_REVOKER);
        gallery.revokeAuthorization(AUTHORIZATION_ID);
    }

    function testRedeemedAuthorizationCannotBeRevokedOrReset() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        vm.expectPartialRevert(GalleryOfSignatures.AuthorizationUnavailable.selector);
        vm.prank(AUTHORIZATION_REVOKER);
        gallery.revokeAuthorization(AUTHORIZATION_ID);
        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 1, "redeemed remains redeemed");
    }

    function testUnknownAuthorizerEpochFailsWithoutConsumption() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        a.authorizerEpoch = 2;
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));

        vm.expectPartialRevert(GalleryOfSignatures.UnknownAuthorizerEpoch.selector);
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);
        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "unknown epoch not consumed");
    }

    function testUnauthorizedControlsFail() public {
        bytes memory unauthorized = abi.encodeWithSignature(
            "AccessControlUnauthorizedAccount(address,bytes32)", ATTACKER, gallery.AUTHORIZER_MANAGER_ROLE()
        );
        vm.expectRevert(unauthorized);
        vm.prank(ATTACKER);
        gallery.addAuthorizerEpoch(2, vm.addr(SECOND_AUTHORIZER_PRIVATE_KEY));

        unauthorized = abi.encodeWithSignature(
            "AccessControlUnauthorizedAccount(address,bytes32)", ATTACKER, gallery.PAUSER_ROLE()
        );
        vm.expectRevert(unauthorized);
        vm.prank(ATTACKER);
        gallery.pauseMinting();

        unauthorized = abi.encodeWithSignature(
            "AccessControlUnauthorizedAccount(address,bytes32)", ATTACKER, gallery.AUTHORIZATION_REVOKER_ROLE()
        );
        vm.expectRevert(unauthorized);
        vm.prank(ATTACKER);
        gallery.revokeAuthorization(AUTHORIZATION_ID);

        vm.prank(PAUSER);
        gallery.pauseMinting();
        unauthorized = abi.encodeWithSignature(
            "AccessControlUnauthorizedAccount(address,bytes32)", ATTACKER, gallery.DEFAULT_ADMIN_ROLE()
        );
        vm.expectRevert(unauthorized);
        vm.prank(ATTACKER);
        gallery.unpauseMinting();
    }

    function testPauseBlocksMintButNotTransferOrEmergencyRevocation() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        vm.prank(PAUSER);
        gallery.pauseMinting();
        _assertTrue(gallery.paused(), "paused");

        vm.prank(MINT_WALLET);
        gallery.transferFrom(MINT_WALLET, SECOND_WALLET, uint256(SIGNATURE_DIGEST));
        _assertEq(gallery.ownerOf(uint256(SIGNATURE_DIGEST)), SECOND_WALLET, "transfer during pause");

        bytes32 anotherAuthorizationId = bytes32(uint256(AUTHORIZATION_ID) + 1);
        vm.prank(AUTHORIZATION_REVOKER);
        gallery.revokeAuthorization(anotherAuthorizationId);
        _assertEq(uint256(gallery.authorizationState(anotherAuthorizationId)), 2, "revocation during pause");

        vm.prank(AUTHORIZER_MANAGER);
        gallery.revokeAuthorizerEpoch(1);
        _assertTrue(gallery.revokedAuthorizerEpoch(1), "epoch revocation during pause");

        GalleryOfSignatures.MintAuthorization memory another = _authorization();
        another.signatureDigest = bytes32(uint256(SIGNATURE_DIGEST) + 1);
        another.authorizationId = bytes32(uint256(AUTHORIZATION_ID) + 2);
        another.mintWallet = MINT_WALLET;
        signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(another));
        vm.expectRevert();
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(another, TOKEN_URI, signature);

        vm.prank(ADMIN);
        gallery.unpauseMinting();
        _assertFalse(gallery.paused(), "admin unpaused");
    }

    function testDefaultAdminTransferRequiresDelayAndAcceptance() public {
        address nextAdmin = address(0xA005);
        vm.prank(PAUSER);
        gallery.pauseMinting();

        vm.prank(ADMIN);
        gallery.beginDefaultAdminTransfer(nextAdmin);
        (address pendingAdmin, uint48 acceptSchedule) = gallery.pendingDefaultAdmin();
        _assertEq(pendingAdmin, nextAdmin, "pending admin");
        _assertEq(uint256(acceptSchedule), block.timestamp + 48 hours, "acceptance schedule");

        vm.expectRevert();
        vm.prank(nextAdmin);
        gallery.acceptDefaultAdminTransfer();

        vm.warp(uint256(acceptSchedule) + 1);
        vm.prank(nextAdmin);
        gallery.acceptDefaultAdminTransfer();
        _assertEq(gallery.defaultAdmin(), nextAdmin, "new delayed admin");

        vm.expectRevert();
        vm.prank(ADMIN);
        gallery.unpauseMinting();
        vm.prank(nextAdmin);
        gallery.unpauseMinting();
        _assertFalse(gallery.paused(), "new admin unpaused");
    }

    function testWalletThatAcquiresCodeBeforeRedemptionFails() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.etch(MINT_WALLET, hex"60006000");

        vm.expectRevert(abi.encodeWithSelector(GalleryOfSignatures.ContractWalletUnsupported.selector, MINT_WALLET));
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);
        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "not consumed");
    }

    function testMintFailureRollsBackBothReplayGuards() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        gallery.seedTokenForAtomicityTest(SECOND_WALLET, uint256(a.signatureDigest));
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));

        vm.expectRevert();
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "authorization write rolled back");
        _assertFalse(gallery.mintedSignature(SIGNATURE_DIGEST), "signature write rolled back");
        _assertEq(gallery.ownerOf(uint256(SIGNATURE_DIGEST)), SECOND_WALLET, "seed owner unchanged");
    }

    function testMintIsNonpayableAndNoForbiddenPublicSurfaceExists() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.deal(address(this), 1 ether);

        (bool paidMintSucceeded,) =
            address(gallery).call{value: 1}(abi.encodeCall(gallery.mintAuthorized, (a, TOKEN_URI, signature)));
        _assertFalse(paidMintSucceeded, "mint accepted payment");
        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 0, "paid call did not consume");

        (bool burnSucceeded,) =
            address(gallery).call(abi.encodeWithSignature("burn(uint256)", uint256(a.signatureDigest)));
        (bool uriMutationSucceeded,) = address(gallery)
            .call(abi.encodeWithSignature("setTokenURI(uint256,string)", uint256(a.signatureDigest), TOKEN_URI));
        (bool adminMintSucceeded,) = address(gallery)
            .call(abi.encodeWithSignature("mint(address,uint256)", MINT_WALLET, uint256(a.signatureDigest)));

        _assertFalse(burnSucceeded, "burn surface exists");
        _assertFalse(uriMutationSucceeded, "URI mutation surface exists");
        _assertFalse(adminMintSucceeded, "alternate mint surface exists");
        _assertFalse(gallery.supportsInterface(0x2a55205a), "ERC-2981 royalties supported");
        _assertFalse(gallery.supportsInterface(0x780e9d63), "ERC-721 Enumerable supported");
    }

    function testStandardTransferDoesNotChangeMintProvenance() public {
        GalleryOfSignatures.MintAuthorization memory a = _authorization();
        bytes memory signature = _sign(AUTHORIZER_PRIVATE_KEY, gallery.authorizationDigest(a));
        vm.prank(MINT_WALLET);
        gallery.mintAuthorized(a, TOKEN_URI, signature);

        vm.prank(MINT_WALLET);
        gallery.transferFrom(MINT_WALLET, SECOND_WALLET, uint256(SIGNATURE_DIGEST));

        _assertEq(gallery.ownerOf(uint256(SIGNATURE_DIGEST)), SECOND_WALLET, "new holder");
        _assertTrue(gallery.mintedSignature(SIGNATURE_DIGEST), "mint provenance remains");
        _assertEq(uint256(gallery.authorizationState(AUTHORIZATION_ID)), 1, "authorization remains redeemed");
        _assertEq(gallery.tokenURI(uint256(SIGNATURE_DIGEST)), TOKEN_URI, "URI remains frozen");
    }

    function _deploy(address initialAuthorizer) private returns (GalleryOfSignaturesHarness) {
        return new GalleryOfSignaturesHarness(
            COLLECTION_NAME,
            COLLECTION_SYMBOL,
            COLLECTION_URI,
            COLLECTION_SHA256,
            keccak256(bytes(COLLECTION_URI)),
            48 hours,
            ADMIN,
            AUTHORIZER_MANAGER,
            PAUSER,
            AUTHORIZATION_REVOKER,
            initialAuthorizer
        );
    }

    function _authorization() private view returns (GalleryOfSignatures.MintAuthorization memory) {
        return GalleryOfSignatures.MintAuthorization({
            signatureDigest: SIGNATURE_DIGEST,
            walletBindingId: WALLET_BINDING_ID,
            mintWallet: MINT_WALLET,
            svgSha256: SVG_SHA256,
            pngSha256: PNG_SHA256,
            metadataSha256: METADATA_SHA256,
            tokenURIHash: keccak256(bytes(TOKEN_URI)),
            authorizationId: AUTHORIZATION_ID,
            validAfter: uint64(block.timestamp - 60),
            deadline: uint64(block.timestamp - 60 + 900),
            authorizerEpoch: 1
        });
    }

    function _expectInvalidAttestation(
        GalleryOfSignatures.MintAuthorization memory a,
        string memory tokenURI_,
        bytes memory signature,
        address caller
    ) private {
        vm.expectRevert(GalleryOfSignatures.InvalidGalleryAttestation.selector);
        vm.prank(caller);
        gallery.mintAuthorized(a, tokenURI_, signature);
    }

    function _sign(uint256 privateKey, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator(string memory name_, string memory version_, uint256 chainId_, address contract_)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name_)), keccak256(bytes(version_)), chainId_, contract_)
        );
    }

    function _splitSignature(bytes memory signature) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
    }

    function _addressTopic(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function _assertSignatureMintedLog(Vm.Log memory entry, uint256 tokenId, bytes32 digest) private pure {
        _assertEq(entry.topics[1], SIGNATURE_DIGEST, "event signature digest");
        _assertEq(entry.topics[2], AUTHORIZATION_ID, "event authorization ID");
        _assertEq(entry.topics[3], _addressTopic(MINT_WALLET), "event mint wallet");

        SignatureMintedData memory eventData = abi.decode(entry.data, (SignatureMintedData));
        _assertEq(eventData.tokenId, tokenId, "event token ID");
        _assertEq(eventData.walletBindingId, WALLET_BINDING_ID, "event binding");
        _assertEq(eventData.svgSha256, SVG_SHA256, "event SVG hash");
        _assertEq(eventData.pngSha256, PNG_SHA256, "event PNG hash");
        _assertEq(eventData.metadataSha256, METADATA_SHA256, "event metadata hash");
        _assertEq(eventData.tokenURIHash, keccak256(bytes(TOKEN_URI)), "event URI hash");
        _assertEq(uint256(eventData.authorizerEpoch), 1, "event epoch");
        _assertEq(eventData.authorizationDigest, digest, "event authorization digest");
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    function _assertFalse(bool value, string memory message) private pure {
        require(!value, message);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertEq(address actual, address expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertEq(bytes32 actual, bytes32 expected, string memory message) private pure {
        require(actual == expected, message);
    }

    function _assertEq(string memory actual, string memory expected, string memory message) private pure {
        require(keccak256(bytes(actual)) == keccak256(bytes(expected)), message);
    }
}
