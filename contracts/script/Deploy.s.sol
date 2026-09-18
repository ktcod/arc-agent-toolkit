// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ArcAssetRegistry} from "../src/ArcAssetRegistry.sol";

/**
 * Deploy ArcAssetRegistry and seed it with canonical Circle infrastructure on Arc mainnet.
 *
 * Addresses transcribed from docs.arc.io/arc/references/contract-addresses (2026-09-18).
 * Seeding happens in the same broadcast as the deployment so the registry is never briefly
 * live-and-empty, which would make `isCanonical` answer "false" for real USDC.
 */
contract Deploy is Script {
    function run() external returns (ArcAssetRegistry registry) {
        address[] memory accounts = new address[](15);
        string[] memory symbols = new string[](15);
        string[] memory roles = new string[](15);

        accounts[0] = 0x3600000000000000000000000000000000000000;
        symbols[0] = "USDC";
        roles[0] = "Circle USDC (also the native gas asset)";

        accounts[1] = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
        symbols[1] = "EURC";
        roles[1] = "Circle EURC";

        accounts[2] = 0x8a5D989Bbb96929F689B0200f435f53dA42bF490;
        symbols[2] = "USYC";
        roles[2] = "Hashnote USYC";

        accounts[3] = 0xb69ecb156Dc0028198028c501340d5367845ca72;
        symbols[3] = "USYC_ENTITLEMENTS";
        roles[3] = "USYC entitlements";

        accounts[4] = 0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b;
        symbols[4] = "USYC_TELLER";
        roles[4] = "USYC teller";

        accounts[5] = 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE;
        symbols[5] = "GATEWAY_WALLET";
        roles[5] = "Circle Gateway wallet (Nanopayments settlement)";

        accounts[6] = 0x2222222d7164433c4C09B0b0D809a9b52C04C205;
        symbols[6] = "GATEWAY_MINTER";
        roles[6] = "Circle Gateway minter";

        accounts[7] = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
        symbols[7] = "TOKEN_MESSENGER_V2";
        roles[7] = "CCTP v2 TokenMessenger";

        accounts[8] = 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64;
        symbols[8] = "MESSAGE_TRANSMITTER_V2";
        roles[8] = "CCTP v2 MessageTransmitter";

        accounts[9] = 0xfd78EE919681417d192449715b2594ab58f5D002;
        symbols[9] = "TOKEN_MINTER_V2";
        roles[9] = "CCTP v2 TokenMinter";

        accounts[10] = 0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78;
        symbols[10] = "MESSAGE_V2";
        roles[10] = "CCTP v2 Message";

        accounts[11] = 0xe2E5F173576B513d994073CCbDaCBE027d43DFe6;
        symbols[11] = "FX_ESCROW";
        roles[11] = "StableFX escrow (a stub on mainnet as of 2026-09-18)";

        accounts[12] = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        symbols[12] = "PERMIT2";
        roles[12] = "Uniswap Permit2";

        accounts[13] = 0xcA11bde05977b3631167028862bE2a173976CA11;
        symbols[13] = "MULTICALL3";
        roles[13] = "Multicall3";

        accounts[14] = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        symbols[14] = "CREATE2_FACTORY";
        roles[14] = "Deterministic CREATE2 factory";

        vm.startBroadcast();
        registry = new ArcAssetRegistry();
        registry.setAssets(accounts, symbols, roles);
        vm.stopBroadcast();

        console2.log("ArcAssetRegistry:", address(registry));
        console2.log("seeded entries:", registry.count());
    }
}
