// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployGalleryOfSignatures} from "../script/DeployGalleryOfSignatures.s.sol";
import {GalleryOfSignatures} from "../src/GalleryOfSignatures.sol";

interface DeploymentTestVm {
    function chainId(uint256 newChainId) external;
    function expectRevert(bytes4 revertData) external;
    function expectPartialRevert(bytes4 revertData) external;
}

contract DeployGalleryOfSignaturesTest {
    DeploymentTestVm private constant vm = DeploymentTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string private constant COLLECTION_URI = "ipfs://bafkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi";
    bytes32 private constant COLLECTION_SHA256 = 0xff0e790009201b46d2ffc7a6e6ec671de641a3c48a973ad78ad7caad4430cf1a;
    bytes32 private constant COLLECTION_URI_HASH = 0x51402158eed04f9de88c4774fb6b2b09a030544addecfc1dc0015daef1674a52;

    address private constant DEPLOYER = address(0xD001);
    address private constant ADMIN = address(0xA001);
    address private constant MANAGER = address(0xA002);
    address private constant PAUSER = address(0xA003);
    address private constant REVOKER = address(0xA004);
    address private constant AUTHORIZER = address(0xA005);

    DeployGalleryOfSignatures private deploymentScript;

    function setUp() public {
        vm.chainId(31_337);
        deploymentScript = new DeployGalleryOfSignatures();
    }

    function testAcceptsExplicitAnvilConfiguration() public view {
        deploymentScript.validateConfiguration(_anvilConfiguration(), block.chainid);
    }

    function testAcceptsExplicitSepoliaConfiguration() public view {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        configuration.expectedChainId = 11_155_111;
        configuration.networkName = "sepolia";
        configuration.documentedGenesisHash = deploymentScript.SEPOLIA_GENESIS_HASH();
        deploymentScript.validateConfiguration(configuration, 11_155_111);
    }

    function testRejectsWrongSepoliaGenesisIdentity() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        configuration.expectedChainId = 11_155_111;
        configuration.networkName = "sepolia";

        vm.expectPartialRevert(DeployGalleryOfSignatures.GenesisHashMismatch.selector);
        deploymentScript.validateConfiguration(configuration, 11_155_111);
    }

    function testMainnetIsUnconditionallyForbidden() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        configuration.expectedChainId = 1;
        configuration.networkName = "mainnet";
        vm.expectRevert(DeployGalleryOfSignatures.MainnetDeploymentForbidden.selector);
        deploymentScript.validateConfiguration(configuration, 1);

        configuration.expectedChainId = 31_337;
        configuration.networkName = "anvil";
        vm.expectRevert(DeployGalleryOfSignatures.MainnetDeploymentForbidden.selector);
        deploymentScript.validateConfiguration(configuration, 1);
    }

    function testRejectsUnsupportedOrMismatchedChainAndNetwork() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        vm.expectPartialRevert(DeployGalleryOfSignatures.UnsupportedRehearsalChain.selector);
        deploymentScript.validateConfiguration(configuration, 10);

        vm.expectPartialRevert(DeployGalleryOfSignatures.ChainIdMismatch.selector);
        deploymentScript.validateConfiguration(configuration, 11_155_111);

        configuration.networkName = "local";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidNetworkName.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);
    }

    function testRejectsWrongDomainCollectionAndAcknowledgement() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        configuration.eip712Version = "3";
        vm.expectRevert(DeployGalleryOfSignatures.WrongEIP712Domain.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionSymbol = "OTHER";
        vm.expectRevert(DeployGalleryOfSignatures.WrongCollectionIdentity.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.acknowledgement = "yes";
        vm.expectRevert(DeployGalleryOfSignatures.MissingRehearsalAcknowledgement.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);
    }

    function testRejectsInvalidCollectionCommitments() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        configuration.collectionURI = "https://gateway.example/ipfs/cid";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://notacid0";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://afkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://bafkrei0bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://bafybeih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://bafkreiz7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://bafkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdb";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://bafkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdii";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURI = "ipfs://bafkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdI";
        vm.expectRevert(DeployGalleryOfSignatures.InvalidCollectionURI.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionURIHash = bytes32(uint256(1));
        vm.expectPartialRevert(DeployGalleryOfSignatures.CollectionURIHashMismatch.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.collectionMetadataSha256 = bytes32(0);
        vm.expectRevert(DeployGalleryOfSignatures.MissingCollectionMetadataHash.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);
    }

    function testRejectsUnsafeRolesAndRetainedDeployerPrivilege() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        configuration.delayedAdmin = DEPLOYER;
        vm.expectPartialRevert(DeployGalleryOfSignatures.DeployerRetainsPrivilege.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.initialAuthorizer = REVOKER;
        vm.expectPartialRevert(DeployGalleryOfSignatures.UnsafeRoleCombination.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.pauser = ADMIN;
        vm.expectPartialRevert(DeployGalleryOfSignatures.UnsafeRoleCombination.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);
    }

    function testRejectsEveryPreviouslyPermittedRoleCollision() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        configuration.authorizerManager = ADMIN;
        vm.expectPartialRevert(DeployGalleryOfSignatures.UnsafeRoleCombination.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.authorizationRevoker = ADMIN;
        vm.expectPartialRevert(DeployGalleryOfSignatures.UnsafeRoleCombination.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.authorizationRevoker = MANAGER;
        vm.expectPartialRevert(DeployGalleryOfSignatures.UnsafeRoleCombination.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);

        configuration = _anvilConfiguration();
        configuration.authorizationRevoker = PAUSER;
        vm.expectPartialRevert(DeployGalleryOfSignatures.UnsafeRoleCombination.selector);
        deploymentScript.validateConfiguration(configuration, 31_337);
    }

    function testInitcodeHashCommitsToEveryConstructorArgument() public view {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
        bytes32 original = deploymentScript.computeDeploymentInitcodeHash(configuration);
        _assertTrue(original != bytes32(0), "initcode hash");
        _assertEq(original, deploymentScript.computeDeploymentInitcodeHash(configuration), "deterministic hash");

        configuration.defaultAdminDelay += 1;
        _assertTrue(
            original != deploymentScript.computeDeploymentInitcodeHash(configuration), "delay changes initcode hash"
        );
        configuration = _anvilConfiguration();
        configuration.authorizationRevoker = address(0xA006);
        _assertTrue(
            original != deploymentScript.computeDeploymentInitcodeHash(configuration), "role changes initcode hash"
        );
    }

    function testValidatesEveryPostDeploymentInvariant() public {
        DeployGalleryOfSignatures.DeploymentConfiguration memory configuration = _anvilConfiguration();
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

        deploymentScript.validateDeployedContract(deployed, configuration);
        _assertTrue(keccak256(address(deployed).code) != bytes32(0), "runtime code hash");
    }

    function _anvilConfiguration()
        private
        pure
        returns (DeployGalleryOfSignatures.DeploymentConfiguration memory configuration)
    {
        configuration = DeployGalleryOfSignatures.DeploymentConfiguration({
            expectedChainId: 31_337,
            networkName: "anvil",
            documentedGenesisHash: bytes32(uint256(1)),
            eip712Name: "signatures.gallery",
            eip712Version: "2",
            collectionName: "Gallery of Signatures",
            collectionSymbol: "SIGN",
            collectionURI: COLLECTION_URI,
            collectionMetadataSha256: COLLECTION_SHA256,
            collectionURIHash: COLLECTION_URI_HASH,
            defaultAdminDelay: 1 hours,
            deployer: DEPLOYER,
            delayedAdmin: ADMIN,
            authorizerManager: MANAGER,
            pauser: PAUSER,
            authorizationRevoker: REVOKER,
            initialAuthorizer: AUTHORIZER,
            acknowledgement: "SEPOLIA_OR_LOCAL_REHEARSAL_ONLY_NO_MAINNET"
        });
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    function _assertEq(bytes32 actual, bytes32 expected, string memory message) private pure {
        require(actual == expected, message);
    }
}
