// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title Gallery of Signatures
/// @notice A non-upgradeable, transferable ERC-721 collection for V1 signatures
///         admitted by a short-lived signatures.gallery EIP-712 authorization.
/// @dev Token IDs are the big-endian uint256 interpretation of the exact V1 SHA-256 digest.
///      There is intentionally no burn, admin mint, URI mutation, royalty, sale, batch,
///      relayer, enumerable, proxy, or upgrade path.
contract GalleryOfSignatures is ERC721URIStorage, EIP712, Pausable, AccessControlDefaultAdminRules {
    struct MintAuthorization {
        bytes32 signatureDigest;
        bytes32 walletBindingId;
        address mintWallet;
        bytes32 svgSha256;
        bytes32 pngSha256;
        bytes32 metadataSha256;
        bytes32 tokenURIHash;
        bytes32 authorizationId;
        uint64 validAfter;
        uint64 deadline;
        uint32 authorizerEpoch;
    }

    bytes32 public constant AUTHORIZER_MANAGER_ROLE = keccak256("AUTHORIZER_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant AUTHORIZATION_REVOKER_ROLE = keccak256("AUTHORIZATION_REVOKER_ROLE");

    uint64 public constant MAX_AUTHORIZATION_WINDOW = 30 minutes;

    bytes32 private constant MINT_AUTHORIZATION_TYPEHASH = keccak256(
        "MintAuthorization(bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch)"
    );

    /// @notice True forever after the corresponding V1 signature has minted.
    mapping(bytes32 signatureDigest => bool minted) public mintedSignature;

    /// @notice Replay state: 0 = unused, 1 = redeemed, 2 = revoked.
    mapping(bytes32 authorizationId => uint8 state) public authorizationState;

    mapping(uint32 epoch => address authorizer) public authorizerByEpoch;
    mapping(uint32 epoch => bool revoked) public revokedAuthorizerEpoch;
    uint32 public currentAuthorizerEpoch;

    string private _collectionURI;
    bytes32 public immutable collectionMetadataSha256;
    bytes32 public immutable collectionURIHash;

    event AuthorizerEpochAdded(uint32 indexed epoch, address indexed authorizer);
    event AuthorizerEpochRevoked(uint32 indexed epoch, address indexed authorizer);
    event AuthorizationRevoked(bytes32 indexed authorizationId);

    event SignatureMinted(
        bytes32 indexed signatureDigest,
        bytes32 indexed authorizationId,
        address indexed mintWallet,
        uint256 tokenId,
        bytes32 walletBindingId,
        bytes32 svgSha256,
        bytes32 pngSha256,
        bytes32 metadataSha256,
        bytes32 tokenURIHash,
        uint32 authorizerEpoch,
        bytes32 authorizationDigest
    );

    error EmptyCollectionURI();
    error CollectionURIHashMismatch(bytes32 expected, bytes32 actual);
    error ZeroOperationalRole(bytes32 role);
    error ZeroInitialAuthorizer();
    error ZeroMintWallet();
    error WrongMintWallet(address expected, address actual);
    error ContractWalletUnsupported(address wallet);
    error InvalidAuthorizationWindow(uint64 validAfter, uint64 deadline);
    error AuthorizationNotActive(uint64 validAfter, uint256 currentTimestamp);
    error AuthorizationExpired(uint64 deadline, uint256 currentTimestamp);
    error AuthorizationWindowTooLong(uint64 duration, uint64 maximum);
    error ZeroWalletBindingId();
    error ZeroAuthorizationId();
    error AuthorizationUnavailable(bytes32 authorizationId, uint8 state);
    error SignatureAlreadyMinted(bytes32 signatureDigest);
    error UnknownAuthorizerEpoch(uint32 epoch);
    error RevokedAuthorizerEpoch(uint32 epoch);
    error TokenURIHashMismatch(bytes32 expected, bytes32 actual);
    error InvalidGalleryAttestation();
    error UnexpectedAuthorizerEpoch(uint32 expected, uint32 actual);
    error AuthorizerEpochAlreadyPopulated(uint32 epoch);
    error AuthorizerEpochAlreadyRevoked(uint32 epoch);
    error AuthorizerEpochOverflow();

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
        ERC721(collectionName_, collectionSymbol_)
        EIP712("signatures.gallery", "2")
        AccessControlDefaultAdminRules(defaultAdminDelay_, delayedAdmin_)
    {
        if (bytes(collectionURI_).length == 0) revert EmptyCollectionURI();

        bytes32 actualCollectionURIHash = keccak256(bytes(collectionURI_));
        if (actualCollectionURIHash != collectionURIHash_) {
            revert CollectionURIHashMismatch(collectionURIHash_, actualCollectionURIHash);
        }
        if (authorizerManager_ == address(0)) revert ZeroOperationalRole(AUTHORIZER_MANAGER_ROLE);
        if (pauser_ == address(0)) revert ZeroOperationalRole(PAUSER_ROLE);
        if (authorizationRevoker_ == address(0)) revert ZeroOperationalRole(AUTHORIZATION_REVOKER_ROLE);
        if (initialAuthorizer_ == address(0)) revert ZeroInitialAuthorizer();

        _collectionURI = collectionURI_;
        collectionMetadataSha256 = collectionMetadataSha256_;
        collectionURIHash = collectionURIHash_;

        authorizerByEpoch[1] = initialAuthorizer_;
        currentAuthorizerEpoch = 1;
        emit AuthorizerEpochAdded(1, initialAuthorizer_);

        _grantRole(AUTHORIZER_MANAGER_ROLE, authorizerManager_);
        _grantRole(PAUSER_ROLE, pauser_);
        _grantRole(AUTHORIZATION_REVOKER_ROLE, authorizationRevoker_);
    }

    /// @notice Constructor-frozen collection-level metadata URI.
    function contractURI() external view returns (string memory) {
        return _collectionURI;
    }

    /// @notice Redeem a gallery authorization directly from its bound EOA.
    function mintAuthorized(MintAuthorization calldata a, string calldata tokenURI_, bytes calldata galleryAttestation)
        external
        whenNotPaused
        returns (uint256 tokenId)
    {
        address authorizer = _validateAuthorization(a, tokenURI_);
        bytes32 digest = _hashTypedDataV4(hashMintAuthorization(a));
        _validateGalleryAttestation(digest, galleryAttestation, authorizer);

        // Consume both replay guards before minting. Any later revert rolls these writes back atomically.
        authorizationState[a.authorizationId] = 1;
        mintedSignature[a.signatureDigest] = true;
        tokenId = uint256(a.signatureDigest);

        _mint(a.mintWallet, tokenId);
        _setTokenURI(tokenId, tokenURI_);

        _emitSignatureMinted(a, tokenId, digest);
    }

    function _emitSignatureMinted(MintAuthorization calldata a, uint256 tokenId, bytes32 digest) private {
        emit SignatureMinted(
            a.signatureDigest,
            a.authorizationId,
            a.mintWallet,
            tokenId,
            a.walletBindingId,
            a.svgSha256,
            a.pngSha256,
            a.metadataSha256,
            a.tokenURIHash,
            a.authorizerEpoch,
            digest
        );
    }

    function _validateAuthorization(MintAuthorization calldata a, string calldata tokenURI_)
        private
        view
        returns (address authorizer)
    {
        if (a.mintWallet == address(0)) revert ZeroMintWallet();
        if (msg.sender != a.mintWallet) revert WrongMintWallet(a.mintWallet, msg.sender);
        if (msg.sender.code.length != 0) revert ContractWalletUnsupported(msg.sender);

        if (a.validAfter >= a.deadline) revert InvalidAuthorizationWindow(a.validAfter, a.deadline);
        if (block.timestamp < a.validAfter) revert AuthorizationNotActive(a.validAfter, block.timestamp);
        if (block.timestamp > a.deadline) revert AuthorizationExpired(a.deadline, block.timestamp);

        uint64 authorizationWindow = a.deadline - a.validAfter;
        if (authorizationWindow > MAX_AUTHORIZATION_WINDOW) {
            revert AuthorizationWindowTooLong(authorizationWindow, MAX_AUTHORIZATION_WINDOW);
        }

        if (a.walletBindingId == bytes32(0)) revert ZeroWalletBindingId();
        if (a.authorizationId == bytes32(0)) revert ZeroAuthorizationId();

        uint8 state = authorizationState[a.authorizationId];
        if (state != 0) revert AuthorizationUnavailable(a.authorizationId, state);
        if (mintedSignature[a.signatureDigest]) revert SignatureAlreadyMinted(a.signatureDigest);

        authorizer = authorizerByEpoch[a.authorizerEpoch];
        if (authorizer == address(0)) revert UnknownAuthorizerEpoch(a.authorizerEpoch);
        if (revokedAuthorizerEpoch[a.authorizerEpoch]) revert RevokedAuthorizerEpoch(a.authorizerEpoch);

        bytes32 actualTokenURIHash = keccak256(bytes(tokenURI_));
        if (actualTokenURIHash != a.tokenURIHash) {
            revert TokenURIHashMismatch(a.tokenURIHash, actualTokenURIHash);
        }
    }

    function _validateGalleryAttestation(bytes32 digest, bytes calldata galleryAttestation, address authorizer)
        private
        pure
    {
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecoverCalldata(digest, galleryAttestation);
        if (recoverError != ECDSA.RecoverError.NoError || recovered != authorizer) {
            revert InvalidGalleryAttestation();
        }
    }

    function addAuthorizerEpoch(uint32 epoch, address authorizer) external onlyRole(AUTHORIZER_MANAGER_ROLE) {
        if (authorizer == address(0)) revert ZeroInitialAuthorizer();
        if (currentAuthorizerEpoch == type(uint32).max) revert AuthorizerEpochOverflow();

        uint32 expectedEpoch = currentAuthorizerEpoch + 1;
        if (epoch != expectedEpoch) revert UnexpectedAuthorizerEpoch(expectedEpoch, epoch);
        if (authorizerByEpoch[epoch] != address(0)) revert AuthorizerEpochAlreadyPopulated(epoch);

        authorizerByEpoch[epoch] = authorizer;
        currentAuthorizerEpoch = epoch;
        emit AuthorizerEpochAdded(epoch, authorizer);
    }

    function revokeAuthorizerEpoch(uint32 epoch) external onlyRole(AUTHORIZER_MANAGER_ROLE) {
        address authorizer = authorizerByEpoch[epoch];
        if (authorizer == address(0)) revert UnknownAuthorizerEpoch(epoch);
        if (revokedAuthorizerEpoch[epoch]) revert AuthorizerEpochAlreadyRevoked(epoch);

        revokedAuthorizerEpoch[epoch] = true;
        emit AuthorizerEpochRevoked(epoch, authorizer);
    }

    function revokeAuthorization(bytes32 authorizationId) external onlyRole(AUTHORIZATION_REVOKER_ROLE) {
        if (authorizationId == bytes32(0)) revert ZeroAuthorizationId();

        uint8 state = authorizationState[authorizationId];
        if (state != 0) revert AuthorizationUnavailable(authorizationId, state);

        authorizationState[authorizationId] = 2;
        emit AuthorizationRevoked(authorizationId);
    }

    function pauseMinting() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpauseMinting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function hashMintAuthorization(MintAuthorization calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MINT_AUTHORIZATION_TYPEHASH,
                a.signatureDigest,
                a.walletBindingId,
                a.mintWallet,
                a.svgSha256,
                a.pngSha256,
                a.metadataSha256,
                a.tokenURIHash,
                a.authorizationId,
                a.validAfter,
                a.deadline,
                a.authorizerEpoch
            )
        );
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721URIStorage, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
