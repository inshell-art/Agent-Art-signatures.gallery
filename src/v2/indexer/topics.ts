import { keccak256, stringToHex } from "viem";

export const FROZEN_GALLERY_ABI_VERSION = "sg-gallery-abi-1.0.0";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}` as const;
export const AUTHORIZER_MANAGER_ROLE = keccak256(stringToHex("AUTHORIZER_MANAGER_ROLE"));
export const PAUSER_ROLE = keccak256(stringToHex("PAUSER_ROLE"));
export const AUTHORIZATION_REVOKER_ROLE = keccak256(stringToHex("AUTHORIZATION_REVOKER_ROLE"));

export const SIGNATURE_MINTED_TOPIC = keccak256(stringToHex("SignatureMinted(bytes32,bytes32,address,uint256,bytes32,bytes32,bytes32,bytes32,bytes32,uint32,bytes32)"));
export const ERC721_TRANSFER_TOPIC = keccak256(stringToHex("Transfer(address,address,uint256)"));
export const AUTHORIZER_EPOCH_ADDED_TOPIC = keccak256(stringToHex("AuthorizerEpochAdded(uint32,address)"));
export const AUTHORIZER_EPOCH_REVOKED_TOPIC = keccak256(stringToHex("AuthorizerEpochRevoked(uint32,address)"));
export const AUTHORIZATION_REVOKED_TOPIC = keccak256(stringToHex("AuthorizationRevoked(bytes32)"));
export const PAUSED_TOPIC = keccak256(stringToHex("Paused(address)"));
export const UNPAUSED_TOPIC = keccak256(stringToHex("Unpaused(address)"));
export const ROLE_GRANTED_TOPIC = keccak256(stringToHex("RoleGranted(bytes32,address,address)"));
export const ROLE_REVOKED_TOPIC = keccak256(stringToHex("RoleRevoked(bytes32,address,address)"));
export const ROLE_ADMIN_CHANGED_TOPIC = keccak256(stringToHex("RoleAdminChanged(bytes32,bytes32,bytes32)"));
export const DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC = keccak256(stringToHex("DefaultAdminTransferScheduled(address,uint48)"));
export const DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC = keccak256(stringToHex("DefaultAdminTransferCanceled()"));
export const DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC = keccak256(stringToHex("DefaultAdminDelayChangeScheduled(uint48,uint48)"));
export const DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC = keccak256(stringToHex("DefaultAdminDelayChangeCanceled()"));
