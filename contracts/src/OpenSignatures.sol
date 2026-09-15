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

/// @notice A separate collection admitting one token per canonical X handle after
///         a trusted backend assessment. Minting does not prove X account ownership.
/// @dev Non-upgradeable; no admin mint, burn, fee, or token/collection URI mutation.
contract OpenSignatures is ERC721URIStorage, EIP712, Pausable, AccessControlDefaultAdminRules {
    struct OpenMintAuthorization {
        bytes32 handleKey;
        bytes32 assessmentDigest;
        bytes32 artifactDigest;
        address recipient;
        bytes32 tokenURIHash;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 deadline;
    }

    struct MintProvenance {
        string normalizedHandle;
        bytes32 assessmentDigest;
        bytes32 artifactDigest;
        address mintRecipient;
        bytes32 tokenURIHash;
        bytes32 authorizationDigest;
    }

    bytes32 public constant AUTHORIZER_MANAGER_ROLE = keccak256("AUTHORIZER_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant NONCE_REVOKER_ROLE = keccak256("NONCE_REVOKER_ROLE");
    uint64 public constant MAX_AUTHORIZATION_WINDOW = 900;
    bytes32 public constant OPEN_MINT_TYPEHASH = keccak256(
        "OpenMintAuthorization(bytes32 handleKey,bytes32 assessmentDigest,bytes32 artifactDigest,address recipient,bytes32 tokenURIHash,bytes32 nonce,uint64 issuedAt,uint64 deadline)"
    );

    address public trustedAuthorizer;
    mapping(bytes32 handleKey_ => bool minted) public mintedHandle;
    mapping(bytes32 nonce => bool used) public usedNonces;
    mapping(bytes32 nonce => bool revoked) public revokedNonces;
    mapping(uint256 tokenId => MintProvenance evidence) public provenance;
    string private _collectionURI;

    event TrustedAuthorizerChanged(address indexed previousAuthorizer, address indexed newAuthorizer);
    event NonceRevoked(bytes32 indexed nonce);
    event OpenSignatureMinted(
        bytes32 indexed handleKey,
        bytes32 indexed nonce,
        address indexed recipient,
        uint256 tokenId,
        string normalizedHandle,
        bytes32 assessmentDigest,
        bytes32 artifactDigest,
        bytes32 tokenURIHash,
        bytes32 authorizationDigest
    );

    error EmptyCollectionURI();
    error ZeroOperationalRole(bytes32 role);
    error ZeroAuthorizer();
    error InvalidHandle();
    error HandleKeyMismatch();
    error ZeroCommitment();
    error ZeroRecipient();
    error WrongRecipient();
    error ContractWalletUnsupported();
    error InvalidAuthorizationWindow();
    error AuthorizationNotActive();
    error AuthorizationExpired();
    error NonceUnavailable();
    error HandleAlreadyMinted();
    error TokenURIHashMismatch();
    error InvalidAttestation();

    constructor(
        string memory collectionName_,
        string memory collectionSymbol_,
        string memory collectionURI_,
        uint48 defaultAdminDelay_,
        address delayedAdmin_,
        address authorizerManager_,
        address pauser_,
        address nonceRevoker_,
        address initialAuthorizer_
    )
        ERC721(collectionName_, collectionSymbol_)
        EIP712("SignaturesOpenMint", "1")
        AccessControlDefaultAdminRules(defaultAdminDelay_, delayedAdmin_)
    {
        if (bytes(collectionURI_).length == 0) revert EmptyCollectionURI();
        if (initialAuthorizer_ == address(0)) revert ZeroAuthorizer();
        if (authorizerManager_ == address(0)) revert ZeroOperationalRole(AUTHORIZER_MANAGER_ROLE);
        if (pauser_ == address(0)) revert ZeroOperationalRole(PAUSER_ROLE);
        if (nonceRevoker_ == address(0)) revert ZeroOperationalRole(NONCE_REVOKER_ROLE);
        _collectionURI = collectionURI_;
        trustedAuthorizer = initialAuthorizer_;
        _grantRole(AUTHORIZER_MANAGER_ROLE, authorizerManager_);
        _grantRole(PAUSER_ROLE, pauser_);
        _grantRole(NONCE_REVOKER_ROLE, nonceRevoker_);
        emit TrustedAuthorizerChanged(address(0), initialAuthorizer_);
    }

    function contractURI() external view returns (string memory) {
        return _collectionURI;
    }

    /// @notice The only mint identity. Neither recipient, MBTI, nor assessment is a key component.
    function handleKey(string memory normalizedHandle) public pure returns (bytes32) {
        bytes memory handle = bytes(normalizedHandle);
        if (handle.length == 0 || handle.length > 15) revert InvalidHandle();
        for (uint256 i; i < handle.length; ++i) {
            bytes1 c = handle[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f)) {
                revert InvalidHandle();
            }
        }
        return keccak256(abi.encode("signatures.gallery/open-handle/v1", normalizedHandle));
    }

    /// @notice Redeem from the authorized EOA. This method is intentionally nonpayable.
    function mint(
        string calldata normalizedHandle,
        OpenMintAuthorization calldata a,
        string calldata tokenURI_,
        bytes calldata signature
    ) external whenNotPaused returns (uint256 tokenId) {
        _validate(normalizedHandle, a, tokenURI_);
        bytes32 digest = authorizationDigest(a);
        (address recovered, ECDSA.RecoverError recoveryError,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (recoveryError != ECDSA.RecoverError.NoError || recovered != trustedAuthorizer) revert InvalidAttestation();

        // Consume both replay guards before minting; a later revert restores both atomically.
        usedNonces[a.nonce] = true;
        mintedHandle[a.handleKey] = true;
        tokenId = uint256(a.handleKey);
        provenance[tokenId] =
            MintProvenance(normalizedHandle, a.assessmentDigest, a.artifactDigest, a.recipient, a.tokenURIHash, digest);
        _mint(a.recipient, tokenId);
        _setTokenURI(tokenId, tokenURI_);
        _emitMint(normalizedHandle, a, tokenId, digest);
    }

    function _validate(string calldata normalizedHandle, OpenMintAuthorization calldata a, string calldata tokenURI_)
        private
        view
    {
        if (handleKey(normalizedHandle) != a.handleKey) revert HandleKeyMismatch();
        if (a.recipient == address(0)) revert ZeroRecipient();
        if (msg.sender != a.recipient) revert WrongRecipient();
        if (msg.sender.code.length != 0) revert ContractWalletUnsupported();
        if (
            a.handleKey == bytes32(0) || a.assessmentDigest == bytes32(0) || a.artifactDigest == bytes32(0)
                || a.tokenURIHash == bytes32(0) || a.nonce == bytes32(0)
        ) revert ZeroCommitment();
        if (a.issuedAt == 0 || a.issuedAt >= a.deadline || a.deadline - a.issuedAt > MAX_AUTHORIZATION_WINDOW) {
            revert InvalidAuthorizationWindow();
        }
        if (block.timestamp < a.issuedAt) revert AuthorizationNotActive();
        if (block.timestamp > a.deadline) revert AuthorizationExpired();
        if (usedNonces[a.nonce] || revokedNonces[a.nonce]) revert NonceUnavailable();
        if (mintedHandle[a.handleKey]) revert HandleAlreadyMinted();
        if (bytes(tokenURI_).length == 0 || keccak256(bytes(tokenURI_)) != a.tokenURIHash) {
            revert TokenURIHashMismatch();
        }
    }

    function _emitMint(
        string calldata normalizedHandle,
        OpenMintAuthorization calldata a,
        uint256 tokenId,
        bytes32 digest
    ) private {
        emit OpenSignatureMinted(
            a.handleKey,
            a.nonce,
            a.recipient,
            tokenId,
            normalizedHandle,
            a.assessmentDigest,
            a.artifactDigest,
            a.tokenURIHash,
            digest
        );
    }

    function hashOpenMintAuthorization(OpenMintAuthorization calldata a) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                OPEN_MINT_TYPEHASH,
                a.handleKey,
                a.assessmentDigest,
                a.artifactDigest,
                a.recipient,
                a.tokenURIHash,
                a.nonce,
                a.issuedAt,
                a.deadline
            )
        );
    }

    function authorizationDigest(OpenMintAuthorization calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(hashOpenMintAuthorization(a));
    }

    /// @notice Rotating the key invalidates outstanding authorizations from the previous signer.
    function setTrustedAuthorizer(address authorizer) external onlyRole(AUTHORIZER_MANAGER_ROLE) {
        if (authorizer == address(0)) revert ZeroAuthorizer();
        address previous = trustedAuthorizer;
        trustedAuthorizer = authorizer;
        emit TrustedAuthorizerChanged(previous, authorizer);
    }

    function revokeNonce(bytes32 nonce) external onlyRole(NONCE_REVOKER_ROLE) {
        if (nonce == bytes32(0)) revert ZeroCommitment();
        if (usedNonces[nonce] || revokedNonces[nonce]) revert NonceUnavailable();
        revokedNonces[nonce] = true;
        emit NonceRevoked(nonce);
    }

    function pauseMinting() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpauseMinting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControlDefaultAdminRules)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
