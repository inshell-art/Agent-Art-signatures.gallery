// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OpenSignatures} from "../src/OpenSignatures.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface OpenVm {
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
    function getRecordedLogs() external returns (Log[] memory);
    function prank(address msgSender) external;
    function recordLogs() external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}

contract OpenSignaturesHarness is OpenSignatures {
    constructor(address admin, address manager, address pauser, address revoker, address signer)
        OpenSignatures(
            "Open Signatures", "OPEN", "ipfs://open-collection", 48 hours, admin, manager, pauser, revoker, signer
        )
    {}

    function seedToken(address recipient, uint256 tokenId) external {
        _mint(recipient, tokenId);
    }
}

contract OpenSignaturesTest {
    OpenVm private constant vm = OpenVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ADMIN = address(0xA001);
    address private constant MANAGER = address(0xA002);
    address private constant PAUSER = address(0xA003);
    address private constant REVOKER = address(0xA004);
    address private constant RECIPIENT = 0x2222222222222222222222222222222222222222;
    address private constant OTHER = address(0xB002);
    string private constant URI = "ipfs://open-mint-vector/metadata.json";
    bytes32 private constant KEY = 0x868ed0b8beee76cb794e5642c5cd60cb76853f3261693b545dd9d0b9aa50a91a;
    bytes32 private constant ASSESSMENT = 0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 private constant ARTIFACT = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 private constant NONCE = 0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 private constant URI_HASH = 0xcbf99d2dad083e24eb59437b752eda77fda8ecbc663f77e3bba0e8e8b6df330b;
    OpenSignaturesHarness private gallery;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_800_000_060);
        gallery = new OpenSignaturesHarness(ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
    }

    function _authorization() private pure returns (OpenSignatures.OpenMintAuthorization memory) {
        return OpenSignatures.OpenMintAuthorization(
            KEY, ASSESSMENT, ARTIFACT, RECIPIENT, URI_HASH, NONCE, 1_800_000_000, 1_800_000_900
        );
    }

    function _signature(OpenSignatures.OpenMintAuthorization memory a) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, gallery.authorizationDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function _mint() private returns (uint256) {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        vm.prank(RECIPIENT);
        return gallery.mint("bigu", a, URI, signature);
    }

    function _reject(OpenSignatures.OpenMintAuthorization memory a, bytes4 error_) private {
        bytes memory signature = _signature(a);
        vm.expectRevert(error_);
        vm.prank(a.recipient);
        gallery.mint("bigu", a, URI, signature);
    }

    function testExactTypeScriptSigningVector() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        require(gallery.handleKey("bigu") == KEY, "canonical key");
        require(
            gallery.OPEN_MINT_TYPEHASH() == 0xdf5eec9a2dd3968e15e1ae75f106d12759ce0ad98cb3267ed82e5278ec92744c,
            "type hash"
        );
        require(
            gallery.hashOpenMintAuthorization(a) == 0x5489ab50c98c6929ff61839ed2ef625eabd73f3bb7db7c159339f47ee8224528,
            "struct hash"
        );
        address vectorAddress = 0x1111111111111111111111111111111111111111;
        vm.etch(vectorAddress, address(gallery).code);
        bytes32 digest = OpenSignatures(vectorAddress).authorizationDigest(a);
        require(digest == 0xb769ac25cc7374bc4aa474bd64acb1a1aed5e6324215012928f0a05c02c72a31, "TS digest");
        bytes memory signature =
            hex"194368c98343eaf582ae494b38d5b6780c27398241b4902b8902485689c11ddc25ed91130926c61bef760d6685c4b3e5baef5a8c738742d8a02dce8fd4fd75851b";
        require(ECDSA.recover(digest, signature) == vm.addr(1), "TS signature");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, digest);
        require(keccak256(abi.encodePacked(r, s, v)) == keccak256(signature), "signature bytes match");
    }

    function testMintSetsImmutableProvenanceAndEvent() public {
        vm.recordLogs();
        uint256 tokenId = _mint();
        require(tokenId == uint256(KEY), "token ID is handle key");
        require(gallery.ownerOf(tokenId) == RECIPIENT, "recipient");
        require(gallery.mintedHandle(KEY) && gallery.usedNonces(NONCE), "both guards consumed");
        require(keccak256(bytes(gallery.tokenURI(tokenId))) == URI_HASH, "immutable URI");
        (
            string memory handle,
            bytes32 assessment,
            bytes32 artifact,
            address recipient,
            bytes32 uriHash,
            bytes32 digest
        ) = gallery.provenance(tokenId);
        require(keccak256(bytes(handle)) == keccak256("bigu"), "handle evidence");
        require(assessment == ASSESSMENT && artifact == ARTIFACT, "commitments");
        require(recipient == RECIPIENT && uriHash == URI_HASH, "mint provenance");
        require(digest == gallery.authorizationDigest(_authorization()), "authorization provenance");
        OpenVm.Log[] memory logs = vm.getRecordedLogs();
        OpenVm.Log memory minted = logs[logs.length - 1];
        require(minted.emitter == address(gallery), "event source");
        require(minted.topics[0] == OpenSignatures.OpenSignatureMinted.selector, "event");
        require(minted.topics[1] == KEY && minted.topics[2] == NONCE, "indexed identity");
        require(minted.topics[3] == bytes32(uint256(uint160(RECIPIENT))), "indexed recipient");
        require(
            keccak256(minted.data) == keccak256(abi.encode(tokenId, "bigu", ASSESSMENT, ARTIFACT, URI_HASH, digest)),
            "event evidence"
        );
    }

    function testTransferPreservesMintProvenanceAndURIWhilePaused() public {
        uint256 tokenId = _mint();
        (, bytes32 a, bytes32 b, address original, bytes32 u, bytes32 d) = gallery.provenance(tokenId);
        vm.prank(PAUSER);
        gallery.pauseMinting();
        vm.prank(RECIPIENT);
        gallery.transferFrom(RECIPIENT, OTHER, tokenId);
        require(gallery.ownerOf(tokenId) == OTHER, "transfer remains enabled");
        (, bytes32 a2, bytes32 b2, address original2, bytes32 u2, bytes32 d2) = gallery.provenance(tokenId);
        require(a == a2 && b == b2 && original == original2 && u == u2 && d == d2, "stable provenance");
        require(original2 == RECIPIENT, "original recipient retained");
        require(keccak256(bytes(gallery.tokenURI(tokenId))) == URI_HASH, "stable URI");
    }

    function testReusedAuthorizationAndNonceCannotMint() public {
        _mint();
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        _reject(a, OpenSignatures.NonceUnavailable.selector);
        a.handleKey = gallery.handleKey("other");
        bytes memory signature = _signature(a);
        vm.expectRevert(OpenSignatures.NonceUnavailable.selector);
        vm.prank(RECIPIENT);
        gallery.mint("other", a, URI, signature);
    }

    function testSameHandleWithDifferentAssessmentMBTIArtifactsRecipientStillDuplicate() public {
        _mint();
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        a.nonce = keccak256("fresh nonce");
        a.assessmentDigest = keccak256("new trusted assessment with different MBTI");
        a.artifactDigest = keccak256("new MBTI artifact");
        a.recipient = OTHER;
        _reject(a, OpenSignatures.HandleAlreadyMinted.selector);
        require(!gallery.usedNonces(a.nonce), "failed duplicate nonce unused");
    }

    function testRejectsCaseAndInvalidHandleBypasses() public {
        string[10] memory handles =
            ["Bigu", "BIGU", "@bigu", " bigu", "bigu ", "bigu\n", "abc.def", "a-b", "", "abcdefghijklmnop"];
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        for (uint256 i; i < handles.length; ++i) {
            vm.expectRevert(OpenSignatures.InvalidHandle.selector);
            vm.prank(RECIPIENT);
            gallery.mint(handles[i], a, URI, signature);
        }
        vm.expectRevert(OpenSignatures.InvalidHandle.selector);
        gallery.handleKey(unicode"ｂigu");
        vm.expectRevert(OpenSignatures.InvalidHandle.selector);
        gallery.handleKey(unicode"é");
        require(gallery.handleKey("a_0123456789abc") != bytes32(0), "15 ASCII bytes accepted");
    }

    function testAlteredHandleRejectedEvenWithTrustedSignature() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        vm.expectRevert(OpenSignatures.HandleKeyMismatch.selector);
        vm.prank(RECIPIENT);
        gallery.mint("other", a, URI, signature);
    }

    function testEverySignedFieldMutationRejected() public {
        bytes memory signature = _signature(_authorization());
        for (uint256 i; i < 8; ++i) {
            OpenSignatures.OpenMintAuthorization memory a = _authorization();
            string memory handle = "bigu";
            string memory uri = URI;
            if (i == 0) handle = "other";
            a.handleKey = gallery.handleKey(handle);
            if (i == 1) a.assessmentDigest = keccak256("altered");
            if (i == 2) a.artifactDigest = keccak256("altered");
            if (i == 3) a.recipient = OTHER;
            if (i == 4) uri = "ipfs://altered";
            a.tokenURIHash = keccak256(bytes(uri));
            if (i == 5) a.nonce = keccak256("altered");
            if (i == 6) a.issuedAt += 1;
            if (i == 7) a.deadline -= 1;
            vm.expectRevert(OpenSignatures.InvalidAttestation.selector);
            vm.prank(a.recipient);
            gallery.mint(handle, a, uri, signature);
        }
        require(!gallery.usedNonces(NONCE) && !gallery.mintedHandle(KEY), "bad attestations consume nothing");
    }

    function testAlteredTokenURIRejected() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        vm.expectRevert(OpenSignatures.TokenURIHashMismatch.selector);
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, "ipfs://other", signature);
        a.tokenURIHash = keccak256("");
        signature = _signature(a);
        vm.expectRevert(OpenSignatures.TokenURIHashMismatch.selector);
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, "", signature);
    }

    function testWrongSenderAndContractWalletRejected() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        vm.expectRevert(OpenSignatures.WrongRecipient.selector);
        vm.prank(OTHER);
        gallery.mint("bigu", a, URI, signature);
        vm.etch(RECIPIENT, hex"00");
        _reject(a, OpenSignatures.ContractWalletUnsupported.selector);
    }

    function testRejectsETH() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory data = abi.encodeCall(OpenSignatures.mint, ("bigu", a, URI, _signature(a)));
        vm.deal(RECIPIENT, 1 ether);
        vm.prank(RECIPIENT);
        (bool success,) = address(gallery).call{value: 1}(data);
        require(!success && address(gallery).balance == 0, "nonpayable");
        require(!gallery.usedNonces(NONCE), "ETH rejection consumes nothing");
    }

    function testExpiredFutureAndInvalidWindowsRejected() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        vm.warp(a.deadline + 1);
        _reject(a, OpenSignatures.AuthorizationExpired.selector);
        vm.warp(a.issuedAt - 1);
        _reject(a, OpenSignatures.AuthorizationNotActive.selector);
        a.deadline = a.issuedAt;
        _reject(a, OpenSignatures.InvalidAuthorizationWindow.selector);
        a.deadline = a.issuedAt - 1;
        _reject(a, OpenSignatures.InvalidAuthorizationWindow.selector);
        a = _authorization();
        a.deadline += 1;
        _reject(a, OpenSignatures.InvalidAuthorizationWindow.selector);
        a.issuedAt = 0;
        _reject(a, OpenSignatures.InvalidAuthorizationWindow.selector);
    }

    function testExactDeadlineIsAccepted() public {
        vm.warp(_authorization().deadline);
        _mint();
    }

    function testExactIssueTimeIsAccepted() public {
        vm.warp(_authorization().issuedAt);
        _mint();
    }

    function testZeroValuesRejected() public {
        for (uint256 i; i < 6; ++i) {
            OpenSignatures.OpenMintAuthorization memory a = _authorization();
            if (i == 0) a.handleKey = bytes32(0);
            if (i == 1) a.assessmentDigest = bytes32(0);
            if (i == 2) a.artifactDigest = bytes32(0);
            if (i == 3) a.tokenURIHash = bytes32(0);
            if (i == 4) a.nonce = bytes32(0);
            if (i == 5) a.recipient = address(0);
            bytes4 expected = i == 0
                ? OpenSignatures.HandleKeyMismatch.selector
                : i == 5 ? OpenSignatures.ZeroRecipient.selector : OpenSignatures.ZeroCommitment.selector;
            _reject(a, expected);
        }
    }

    function testWrongChainAndContractSignaturesRejected() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        vm.chainId(31338);
        vm.expectRevert(OpenSignatures.InvalidAttestation.selector);
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, URI, signature);
        vm.chainId(31337);
        OpenSignatures second = new OpenSignaturesHarness(ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
        vm.expectRevert(OpenSignatures.InvalidAttestation.selector);
        vm.prank(RECIPIENT);
        second.mint("bigu", a, URI, signature);
    }

    function testWrongDomainNameAndVersionRejected() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        for (uint256 i; i < 2; ++i) {
            bytes32 domainSeparator = keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256(bytes(i == 0 ? "signatures.gallery" : "SignaturesOpenMint")),
                    keccak256(bytes(i == 1 ? "2" : "1")),
                    block.chainid,
                    address(gallery)
                )
            );
            bytes32 digest =
                keccak256(abi.encodePacked(hex"1901", domainSeparator, gallery.hashOpenMintAuthorization(a)));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, digest);
            vm.expectRevert(OpenSignatures.InvalidAttestation.selector);
            vm.prank(RECIPIENT);
            gallery.mint("bigu", a, URI, abi.encodePacked(r, s, v));
        }
    }

    function testMalformedAndHighSSignaturesRejected() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        vm.expectRevert(OpenSignatures.InvalidAttestation.selector);
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, URI, hex"0102");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, gallery.authorizationDigest(a));
        bytes32 highS = bytes32(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - uint256(s));
        vm.expectRevert(OpenSignatures.InvalidAttestation.selector);
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, URI, abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27)));
    }

    function testMintFailureRollsBackBothReplayGuardsAndEvidence() public {
        gallery.seedToken(OTHER, uint256(KEY));
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        vm.expectRevert();
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, URI, signature);
        require(!gallery.mintedHandle(KEY) && !gallery.usedNonces(NONCE), "atomic guards");
        (string memory handle,,,,,) = gallery.provenance(uint256(KEY));
        require(bytes(handle).length == 0, "atomic evidence");
    }

    function testSeparatedRolesAndDelayedAdmin() public view {
        require(gallery.defaultAdmin() == ADMIN && gallery.defaultAdminDelay() == 48 hours, "delayed admin");
        require(gallery.hasRole(gallery.AUTHORIZER_MANAGER_ROLE(), MANAGER), "manager");
        require(gallery.hasRole(gallery.PAUSER_ROLE(), PAUSER), "pauser");
        require(gallery.hasRole(gallery.NONCE_REVOKER_ROLE(), REVOKER), "revoker");
        require(!gallery.hasRole(gallery.DEFAULT_ADMIN_ROLE(), address(this)), "deployer has no admin");
        require(keccak256(bytes(gallery.contractURI())) == keccak256("ipfs://open-collection"), "collection URI");
        require(gallery.supportsInterface(0x80ac58cd) && gallery.supportsInterface(0x5b5e139f), "ERC721 and metadata");
    }

    function testUnauthorizedRolesCannotMutateOperationalControls() public {
        vm.expectRevert();
        gallery.setTrustedAuthorizer(OTHER);
        vm.expectRevert();
        gallery.revokeNonce(NONCE);
        vm.expectRevert();
        gallery.pauseMinting();
        vm.prank(PAUSER);
        gallery.pauseMinting();
        vm.expectRevert();
        vm.prank(PAUSER);
        gallery.unpauseMinting();
        vm.prank(ADMIN);
        gallery.unpauseMinting();
    }

    function testPauseThenAdminResumeMinting() public {
        vm.prank(PAUSER);
        gallery.pauseMinting();
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        vm.expectRevert();
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, URI, signature);
        vm.prank(ADMIN);
        gallery.unpauseMinting();
        _mint();
    }

    function testRevokedNonceCannotMint() public {
        vm.prank(REVOKER);
        gallery.revokeNonce(NONCE);
        require(gallery.revokedNonces(NONCE), "revoked");
        _reject(_authorization(), OpenSignatures.NonceUnavailable.selector);
        vm.expectRevert(OpenSignatures.NonceUnavailable.selector);
        vm.prank(REVOKER);
        gallery.revokeNonce(NONCE);
    }

    function testRotationInvalidatesOldAttestationAndAcceptsNewSigner() public {
        OpenSignatures.OpenMintAuthorization memory a = _authorization();
        bytes memory signature = _signature(a);
        address newSigner = vm.addr(2);
        vm.prank(MANAGER);
        gallery.setTrustedAuthorizer(newSigner);
        require(gallery.trustedAuthorizer() == newSigner, "new trusted signer");
        vm.expectRevert(OpenSignatures.InvalidAttestation.selector);
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, URI, signature);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(2, gallery.authorizationDigest(a));
        vm.prank(RECIPIENT);
        gallery.mint("bigu", a, URI, abi.encodePacked(r, s, v));
    }

    function testRejectsZeroAuthorizerAndRoles() public {
        vm.expectRevert(OpenSignatures.ZeroAuthorizer.selector);
        vm.prank(MANAGER);
        gallery.setTrustedAuthorizer(address(0));
        vm.expectRevert(OpenSignatures.ZeroAuthorizer.selector);
        new OpenSignaturesHarness(ADMIN, MANAGER, PAUSER, REVOKER, address(0));
        vm.expectRevert();
        new OpenSignaturesHarness(address(0), MANAGER, PAUSER, REVOKER, OTHER);
        vm.expectRevert();
        new OpenSignaturesHarness(ADMIN, address(0), PAUSER, REVOKER, OTHER);
        vm.expectRevert();
        new OpenSignaturesHarness(ADMIN, MANAGER, address(0), REVOKER, OTHER);
        vm.expectRevert();
        new OpenSignaturesHarness(ADMIN, MANAGER, PAUSER, address(0), OTHER);
    }

    function testNoAdminMintBurnOrURIMutationSelectors() public {
        uint256 id = _mint();
        bytes[4] memory calls = [
            abi.encodeWithSignature("adminMint(address,uint256)", OTHER, 1),
            abi.encodeWithSignature("burn(uint256)", id),
            abi.encodeWithSignature("setTokenURI(uint256,string)", id, "changed"),
            abi.encodeWithSignature("upgradeTo(address)", OTHER)
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(ADMIN);
            (bool success,) = address(gallery).call(calls[i]);
            require(!success, "unauthorized mutation interface exists");
        }
    }

    function testFuzzHandleKeyAlwaysMatchesCanonicalAbi(bytes15 input, uint8 rawLength) public view {
        uint256 length = uint256(rawLength) % 15 + 1;
        bytes memory handle = new bytes(length);
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
        for (uint256 i; i < length; ++i) {
            handle[i] = alphabet[uint8(input[i]) % alphabet.length];
        }
        require(
            gallery.handleKey(string(handle))
                == keccak256(abi.encode("signatures.gallery/open-handle/v1", string(handle))),
            "ABI identity"
        );
    }
}
