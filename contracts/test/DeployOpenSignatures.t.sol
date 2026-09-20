// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployOpenSignatures} from "../script/DeployOpenSignatures.s.sol";
import {OpenSignatures} from "../src/OpenSignatures.sol";

interface OpenDeploymentTestVm {
    function chainId(uint256 id) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function etch(address target, bytes calldata code) external;
}

contract DeployOpenSignaturesTest {
    OpenDeploymentTestVm private constant VM = OpenDeploymentTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DeployOpenSignatures private script;

    function setUp() public { VM.chainId(31337); script = new DeployOpenSignatures(); }

    function _configuration() private pure returns (DeployOpenSignatures.Configuration memory c) {
        c.expectedChainId = 31337;
        c.domainName = "SignaturesOpenMint"; c.domainVersion = "1";
        c.collectionName = "Open Signatures local preparation"; c.collectionSymbol = "OPEN";
        c.collectionURI = "ipfs://bafkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi";
        c.adminDelay = 2 days;
        c.deployer = address(0xD001); c.delayedAdmin = address(0xA001);
        c.authorizerManager = address(0xA002); c.pauser = address(0xA003);
        c.nonceRevoker = address(0xA004); c.authorizer = address(0xA005);
        c.acknowledgement = "LOCAL_ONLY_NO_PUBLIC_BROADCAST";
    }

    function testLocalDeploymentChecksOnlyActualOpenSignaturesGetters() public {
        DeployOpenSignatures.Configuration memory c = _configuration();
        OpenSignatures deployed = script.deployLocal(c);
        script.validateDeployed(deployed, c);
        require(keccak256(bytes(deployed.contractURI())) == keccak256(bytes(c.collectionURI)));
        require(deployed.trustedAuthorizer() == c.authorizer);
        require(!deployed.hasRole(deployed.DEFAULT_ADMIN_ROLE(), c.deployer));
        require(!deployed.hasRole(deployed.NONCE_REVOKER_ROLE(), c.authorizer));
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) = deployed.eip712Domain();
        require(fields == hex"0f" && keccak256(bytes(name)) == keccak256("SignaturesOpenMint"));
        require(keccak256(bytes(version)) == keccak256("1") && chainId == 31337 && verifying == address(deployed));
    }

    function testPublicBroadcastAlwaysRefusedIncludingSuggestedTestnet() public {
        DeployOpenSignatures.Configuration memory c = _configuration();
        VM.expectRevert(DeployOpenSignatures.PublicBroadcastNotApproved.selector); script.validateConfiguration(c, 1);
        VM.expectRevert(DeployOpenSignatures.PublicBroadcastNotApproved.selector); script.validateConfiguration(c, 11155111);
        c.expectedChainId = 11155111;
        VM.expectRevert(DeployOpenSignatures.PublicBroadcastNotApproved.selector); script.validateConfiguration(c, 31337);
        VM.chainId(11155111);
        VM.expectRevert(DeployOpenSignatures.PublicBroadcastNotApproved.selector); script.deployLocal(c);
    }

    function testWrongDomainAndLegacyVersionRefused() public {
        DeployOpenSignatures.Configuration memory c = _configuration(); c.domainName = "signatures.gallery";
        VM.expectRevert(DeployOpenSignatures.WrongDomain.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); c.domainVersion = "2";
        VM.expectRevert(DeployOpenSignatures.WrongDomain.selector); script.validateConfiguration(c, 31337);
    }

    function testEmptyMutableOrNoncanonicalCollectionAndZeroDelayRefused() public {
        DeployOpenSignatures.Configuration memory c = _configuration(); c.collectionURI = "https://localhost/metadata.json";
        VM.expectRevert(DeployOpenSignatures.InvalidCollection.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); c.collectionURI = string.concat(c.collectionURI, "/metadata.json");
        VM.expectRevert(DeployOpenSignatures.InvalidCollection.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); bytes(c.collectionURI)[65] = "j";
        VM.expectRevert(DeployOpenSignatures.InvalidCollection.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); c.collectionName = "";
        VM.expectRevert(DeployOpenSignatures.InvalidCollection.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); c.adminDelay = 0;
        VM.expectRevert(DeployOpenSignatures.InvalidDelay.selector); script.validateConfiguration(c, 31337);
    }

    function testRequiresExplicitLocalAcknowledgement() public {
        DeployOpenSignatures.Configuration memory c = _configuration(); c.acknowledgement = "approved";
        VM.expectRevert(DeployOpenSignatures.MissingAcknowledgement.selector); script.deployLocal(c);
    }

    function testFuzzEveryRoleCollisionOrZeroIsRefused(uint8 first, uint8 second) public {
        first %= 6; second %= 6;
        DeployOpenSignatures.Configuration memory c = _configuration();
        address[6] memory identities = [c.deployer, c.delayedAdmin, c.authorizerManager, c.pauser, c.nonceRevoker, c.authorizer];
        _setIdentity(c, second, first == second ? address(0) : identities[first]);
        VM.expectRevert(DeployOpenSignatures.InvalidRoleIdentity.selector); script.validateConfiguration(c, 31337);
    }

    function testInitcodeHashBindsExactConstructorIncludingImmutableURI() public view {
        DeployOpenSignatures.Configuration memory c = _configuration();
        bytes32 expected = keccak256(abi.encodePacked(type(OpenSignatures).creationCode, abi.encode(c.collectionName, c.collectionSymbol,
            c.collectionURI, c.adminDelay, c.delayedAdmin, c.authorizerManager, c.pauser, c.nonceRevoker, c.authorizer)));
        require(script.deploymentInitcodeHash(c) == expected);
        c.authorizer = address(0xB001); require(script.deploymentInitcodeHash(c) != expected);
    }

    function testChangedSignerPauseOrExtraRoleFailsInitialObservation() public {
        DeployOpenSignatures.Configuration memory c = _configuration(); OpenSignatures deployed = script.deployLocal(c);
        VM.prank(c.authorizerManager); deployed.setTrustedAuthorizer(address(0xB001));
        VM.expectRevert(DeployOpenSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
        VM.prank(c.authorizerManager); deployed.setTrustedAuthorizer(c.authorizer);
        VM.prank(c.pauser); deployed.pauseMinting();
        VM.expectRevert(DeployOpenSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
        VM.prank(c.delayedAdmin); deployed.unpauseMinting();
        script.validateDeployed(deployed, c);
        bytes32 pauserRole = deployed.PAUSER_ROLE();
        VM.prank(c.delayedAdmin); deployed.grantRole(pauserRole, c.deployer);
        VM.expectRevert(DeployOpenSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
    }

    function testSeparateNonceRevokerWorksWithoutURIOrSignerMutation() public {
        DeployOpenSignatures.Configuration memory c = _configuration(); OpenSignatures deployed = script.deployLocal(c);
        VM.prank(c.nonceRevoker); deployed.revokeNonce(bytes32(uint256(7)));
        require(deployed.revokedNonces(bytes32(uint256(7)))); script.validateDeployed(deployed, c);
    }

    function testMissingRuntimeCannotPass() public {
        DeployOpenSignatures.Configuration memory c = _configuration(); OpenSignatures deployed = script.deployLocal(c);
        VM.etch(address(deployed), hex"");
        VM.expectRevert(DeployOpenSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
    }

    function _setIdentity(DeployOpenSignatures.Configuration memory c, uint8 index, address value) private pure {
        if (index == 0) c.deployer = value; else if (index == 1) c.delayedAdmin = value;
        else if (index == 2) c.authorizerManager = value; else if (index == 3) c.pauser = value;
        else if (index == 4) c.nonceRevoker = value; else c.authorizer = value;
    }
}
