// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GalleryOfSignatures} from "../src/GalleryOfSignatures.sol";

interface DeploymentVm {
    function envAddress(string calldata name) external returns (address value);
    function envBytes32(string calldata name) external returns (bytes32 value);
    function envString(string calldata name) external returns (string memory value);
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

/// @notice Rehearsal-only Foundry deployment script for Anvil and Sepolia.
/// @dev Ethereum mainnet is intentionally rejected. A later, separately authorized
///      change must deliberately remove that guard before any mainnet transaction.
///      No private key is read here: Foundry must obtain signing authority through
///      an external keystore, hardware wallet, or other CLI-configured signer.
contract DeployGalleryOfSignatures {
    struct DeploymentConfiguration {
        uint256 expectedChainId;
        string networkName;
        bytes32 documentedGenesisHash;
        string eip712Name;
        string eip712Version;
        string collectionName;
        string collectionSymbol;
        string collectionURI;
        bytes32 collectionMetadataSha256;
        bytes32 collectionURIHash;
        uint48 defaultAdminDelay;
        address deployer;
        address delayedAdmin;
        address authorizerManager;
        address pauser;
        address authorizationRevoker;
        address initialAuthorizer;
        string acknowledgement;
    }

    uint256 public constant ETHEREUM_MAINNET_CHAIN_ID = 1;
    uint256 public constant SEPOLIA_CHAIN_ID = 11_155_111;
    uint256 public constant ANVIL_CHAIN_ID = 31_337;
    bytes32 public constant SEPOLIA_GENESIS_HASH = 0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9;

    string public constant EIP712_NAME = "signatures.gallery";
    string public constant EIP712_VERSION = "2";
    string public constant COLLECTION_NAME = "Gallery of Signatures";
    string public constant COLLECTION_SYMBOL = "SIGN";
    string public constant REQUIRED_ACKNOWLEDGEMENT = "SEPOLIA_OR_LOCAL_REHEARSAL_ONLY_NO_MAINNET";

    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error MainnetDeploymentForbidden();
    error UnsupportedRehearsalChain(uint256 chainId);
    error ChainIdMismatch(uint256 expected, uint256 actual);
    error InvalidNetworkName();
    error MissingGenesisHash();
    error GenesisHashMismatch(bytes32 expected, bytes32 actual);
    error WrongEIP712Domain();
    error WrongCollectionIdentity();
    error InvalidCollectionURI();
    error CollectionURIHashMismatch(bytes32 expected, bytes32 actual);
    error MissingCollectionMetadataHash();
    error InvalidAdminDelay(uint256 delay);
    error ZeroDeploymentAddress(bytes32 field);
    error DeployerRetainsPrivilege(address deployer);
    error UnsafeRoleCombination(bytes32 firstRole, bytes32 secondRole);
    error MissingRehearsalAcknowledgement();
    error DeploymentInvariantFailed(bytes32 invariantName);

    function run() external returns (address deployedAddress, bytes32 deploymentInitcodeHash, bytes32 runtimeCodeHash) {
        DeploymentConfiguration memory configuration = loadConfigurationFromEnvironment();
        validateConfiguration(configuration, block.chainid);
        deploymentInitcodeHash = computeDeploymentInitcodeHash(configuration);

        vm.startBroadcast(configuration.deployer);
        GalleryOfSignatures deployed = new GalleryOfSignatures(
            configuration.collectionName,
            configuration.collectionSymbol,
            configuration.collectionURI,
            configuration.collectionMetadataSha256,
            configuration.collectionURIHash,
            configuration.defaultAdminDelay,
            configuration.delayedAdmin,
            configuration.authorizerManager,
            configuration.pauser,
            configuration.authorizationRevoker,
            configuration.initialAuthorizer
        );
        vm.stopBroadcast();

        validateDeployedContract(deployed, configuration);
        deployedAddress = address(deployed);
        runtimeCodeHash = keccak256(deployedAddress.code);
    }

    function loadConfigurationFromEnvironment() public returns (DeploymentConfiguration memory configuration) {
        configuration.expectedChainId = vm.envUint("DEPLOY_EXPECTED_CHAIN_ID");
        configuration.networkName = vm.envString("DEPLOY_NETWORK_NAME");
        configuration.documentedGenesisHash = vm.envBytes32("DEPLOY_GENESIS_HASH");
        configuration.eip712Name = vm.envString("DEPLOY_EIP712_NAME");
        configuration.eip712Version = vm.envString("DEPLOY_EIP712_VERSION");
        configuration.collectionName = vm.envString("DEPLOY_COLLECTION_NAME");
        configuration.collectionSymbol = vm.envString("DEPLOY_COLLECTION_SYMBOL");
        configuration.collectionURI = vm.envString("DEPLOY_COLLECTION_URI");
        configuration.collectionMetadataSha256 = vm.envBytes32("DEPLOY_COLLECTION_METADATA_SHA256");
        configuration.collectionURIHash = vm.envBytes32("DEPLOY_COLLECTION_URI_HASH");
        configuration.defaultAdminDelay = _checkedAdminDelay(vm.envUint("DEPLOY_DEFAULT_ADMIN_DELAY_SECONDS"));
        configuration.deployer = vm.envAddress("DEPLOYER_ADDRESS");
        configuration.delayedAdmin = vm.envAddress("DEPLOY_DELAYED_ADMIN");
        configuration.authorizerManager = vm.envAddress("DEPLOY_AUTHORIZER_MANAGER");
        configuration.pauser = vm.envAddress("DEPLOY_PAUSER");
        configuration.authorizationRevoker = vm.envAddress("DEPLOY_AUTHORIZATION_REVOKER");
        configuration.initialAuthorizer = vm.envAddress("DEPLOY_INITIAL_AUTHORIZER");
        configuration.acknowledgement = vm.envString("DEPLOY_ACKNOWLEDGEMENT");
    }

    function validateConfiguration(DeploymentConfiguration memory configuration, uint256 actualChainId) public pure {
        if (actualChainId == ETHEREUM_MAINNET_CHAIN_ID || configuration.expectedChainId == ETHEREUM_MAINNET_CHAIN_ID) {
            revert MainnetDeploymentForbidden();
        }
        if (actualChainId != SEPOLIA_CHAIN_ID && actualChainId != ANVIL_CHAIN_ID) {
            revert UnsupportedRehearsalChain(actualChainId);
        }
        if (configuration.expectedChainId != actualChainId) {
            revert ChainIdMismatch(configuration.expectedChainId, actualChainId);
        }
        if (!_validNetworkName(configuration.networkName, actualChainId)) revert InvalidNetworkName();
        if (configuration.documentedGenesisHash == bytes32(0)) revert MissingGenesisHash();
        if (actualChainId == SEPOLIA_CHAIN_ID && configuration.documentedGenesisHash != SEPOLIA_GENESIS_HASH) {
            revert GenesisHashMismatch(SEPOLIA_GENESIS_HASH, configuration.documentedGenesisHash);
        }

        if (!_equal(configuration.eip712Name, EIP712_NAME) || !_equal(configuration.eip712Version, EIP712_VERSION)) {
            revert WrongEIP712Domain();
        }
        if (
            !_equal(configuration.collectionName, COLLECTION_NAME)
                || !_equal(configuration.collectionSymbol, COLLECTION_SYMBOL)
        ) {
            revert WrongCollectionIdentity();
        }
        if (!_isCanonicalRawSha256CidURI(configuration.collectionURI)) revert InvalidCollectionURI();
        bytes32 actualCollectionURIHash = keccak256(bytes(configuration.collectionURI));
        if (actualCollectionURIHash != configuration.collectionURIHash) {
            revert CollectionURIHashMismatch(configuration.collectionURIHash, actualCollectionURIHash);
        }
        if (configuration.collectionMetadataSha256 == bytes32(0)) revert MissingCollectionMetadataHash();
        if (configuration.defaultAdminDelay == 0) revert InvalidAdminDelay(0);

        _requireAddress(configuration.deployer, "deployer");
        _requireAddress(configuration.delayedAdmin, "delayedAdmin");
        _requireAddress(configuration.authorizerManager, "authorizerManager");
        _requireAddress(configuration.pauser, "pauser");
        _requireAddress(configuration.authorizationRevoker, "authorizationRevoker");
        _requireAddress(configuration.initialAuthorizer, "initialAuthorizer");

        _requirePairwiseDistinctIdentities(configuration);
        if (!_equal(configuration.acknowledgement, REQUIRED_ACKNOWLEDGEMENT)) {
            revert MissingRehearsalAcknowledgement();
        }
    }

    function computeDeploymentInitcodeHash(DeploymentConfiguration memory configuration) public pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(GalleryOfSignatures).creationCode,
                abi.encode(
                    configuration.collectionName,
                    configuration.collectionSymbol,
                    configuration.collectionURI,
                    configuration.collectionMetadataSha256,
                    configuration.collectionURIHash,
                    configuration.defaultAdminDelay,
                    configuration.delayedAdmin,
                    configuration.authorizerManager,
                    configuration.pauser,
                    configuration.authorizationRevoker,
                    configuration.initialAuthorizer
                )
            )
        );
    }

    function validateDeployedContract(GalleryOfSignatures deployed, DeploymentConfiguration memory configuration)
        public
        view
    {
        if (address(deployed).code.length == 0) revert DeploymentInvariantFailed("runtimeCode");
        if (!_equal(deployed.name(), COLLECTION_NAME)) revert DeploymentInvariantFailed("name");
        if (!_equal(deployed.symbol(), COLLECTION_SYMBOL)) revert DeploymentInvariantFailed("symbol");
        if (!_equal(deployed.contractURI(), configuration.collectionURI)) {
            revert DeploymentInvariantFailed("contractURI");
        }
        if (deployed.collectionMetadataSha256() != configuration.collectionMetadataSha256) {
            revert DeploymentInvariantFailed("collectionMetadataSha256");
        }
        if (deployed.collectionURIHash() != configuration.collectionURIHash) {
            revert DeploymentInvariantFailed("collectionURIHash");
        }
        if (deployed.defaultAdmin() != configuration.delayedAdmin) {
            revert DeploymentInvariantFailed("defaultAdmin");
        }
        if (deployed.defaultAdminDelay() != configuration.defaultAdminDelay) {
            revert DeploymentInvariantFailed("defaultAdminDelay");
        }
        if (!deployed.hasRole(deployed.AUTHORIZER_MANAGER_ROLE(), configuration.authorizerManager)) {
            revert DeploymentInvariantFailed("authorizerManager");
        }
        if (!deployed.hasRole(deployed.PAUSER_ROLE(), configuration.pauser)) {
            revert DeploymentInvariantFailed("pauser");
        }
        if (!deployed.hasRole(deployed.AUTHORIZATION_REVOKER_ROLE(), configuration.authorizationRevoker)) {
            revert DeploymentInvariantFailed("authorizationRevoker");
        }
        if (deployed.currentAuthorizerEpoch() != 1 || deployed.authorizerByEpoch(1) != configuration.initialAuthorizer)
        {
            revert DeploymentInvariantFailed("initialAuthorizerEpoch");
        }
        if (deployed.paused()) revert DeploymentInvariantFailed("paused");

        (bytes1 fields, string memory name_, string memory version_, uint256 chainId_, address verifyingContract,,) =
            deployed.eip712Domain();
        if (
            fields != hex"0f" || !_equal(name_, EIP712_NAME) || !_equal(version_, EIP712_VERSION)
                || chainId_ != block.chainid || verifyingContract != address(deployed)
        ) {
            revert DeploymentInvariantFailed("eip712Domain");
        }
    }

    function _checkedAdminDelay(uint256 delay) private pure returns (uint48) {
        if (delay == 0 || delay > type(uint48).max) revert InvalidAdminDelay(delay);
        return uint48(delay);
    }

    function _requireAddress(address value, bytes32 field) private pure {
        if (value == address(0)) revert ZeroDeploymentAddress(field);
    }

    function _requirePairwiseDistinctIdentities(DeploymentConfiguration memory configuration) private pure {
        address[6] memory identities = [
            configuration.deployer,
            configuration.delayedAdmin,
            configuration.authorizerManager,
            configuration.pauser,
            configuration.authorizationRevoker,
            configuration.initialAuthorizer
        ];
        bytes32[6] memory labels = [
            bytes32("deployer"),
            bytes32("delayedAdmin"),
            bytes32("authorizerManager"),
            bytes32("pauser"),
            bytes32("authorizationRevoker"),
            bytes32("initialAuthorizer")
        ];

        for (uint256 i = 0; i < identities.length; ++i) {
            for (uint256 j = i + 1; j < identities.length; ++j) {
                if (identities[i] != identities[j]) continue;
                if (i == 0) revert DeployerRetainsPrivilege(identities[i]);
                revert UnsafeRoleCombination(labels[i], labels[j]);
            }
        }
    }

    function _validNetworkName(string memory networkName, uint256 chainId) private pure returns (bool) {
        if (chainId == SEPOLIA_CHAIN_ID) return _equal(networkName, "sepolia");
        if (chainId == ANVIL_CHAIN_ID) return _equal(networkName, "anvil");
        return false;
    }

    /// @dev The frozen importer emits a CIDv1 whose bytes are exactly
    ///      0x01 (CIDv1) || 0x55 (raw) || 0x12 (sha2-256) || 0x20 || digest[32].
    ///      Its canonical unpadded lowercase Base32 text is therefore exactly
    ///      59 characters (`bafkrei...`), with constrained header spill and
    ///      trailing padding bits. Including `ipfs://`, the URI is 66 bytes.
    function _isCanonicalRawSha256CidURI(string memory uri) private pure returns (bool) {
        bytes memory value = bytes(uri);
        if (value.length != 66) return false;
        if (
            value[0] != "i" || value[1] != "p" || value[2] != "f" || value[3] != "s" || value[4] != ":"
                || value[5] != "/" || value[6] != "/"
        ) return false;

        bytes memory fixedPrefix = bytes("bafkrei");
        for (uint256 i = 0; i < fixedPrefix.length; ++i) {
            if (value[7 + i] != fixedPrefix[i]) return false;
        }

        // The next Base32 symbol contains the final two zero bits of the
        // 0x20 digest-length byte and three arbitrary digest bits.
        if (value[14] < "a" || value[14] > "h") return false;

        for (uint256 i = 14; i < value.length; ++i) {
            bytes1 character = value[i];
            bool lowercaseLetter = character >= "a" && character <= "z";
            bool base32Digit = character >= "2" && character <= "7";
            if (!lowercaseLetter && !base32Digit) return false;
        }

        // Thirty-six CID bytes leave three significant bits in the final
        // Base32 symbol. Canonical no-padding encoding requires its two low
        // bits to be zero.
        bytes1 finalCharacter = value[65];
        return finalCharacter == "a" || finalCharacter == "e" || finalCharacter == "i" || finalCharacter == "m"
            || finalCharacter == "q" || finalCharacter == "u" || finalCharacter == "y" || finalCharacter == "4";
    }

    function _equal(string memory left, string memory right) private pure returns (bool) {
        return keccak256(bytes(left)) == keccak256(bytes(right));
    }
}
