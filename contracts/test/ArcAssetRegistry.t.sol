// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcAssetRegistry} from "../src/ArcAssetRegistry.sol";

contract ArcAssetRegistryTest is Test {
    ArcAssetRegistry registry;

    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant FAKE = 0xaaC788737179Cd696d19b1A09c5392033C9127A6; // real observed USDCARC
    address constant STRANGER = address(0xBEEF);

    function setUp() public {
        registry = new ArcAssetRegistry();
        registry.setAsset(USDC, "USDC", "Circle USDC (also the native gas asset)");
    }

    function test_canonicalAddressIsRecognised() public view {
        assertTrue(registry.isCanonical(USDC));
        assertEq(registry.symbolOf(USDC), "USDC");
        assertEq(registry.canonicalOf("USDC"), USDC);
    }

    /// The whole point: a real impersonator observed on Arc must NOT read as canonical.
    function test_impersonatorIsNotCanonical() public view {
        assertFalse(registry.isCanonical(FAKE));
        assertEq(registry.symbolOf(FAKE), "");
    }

    function test_unknownSymbolResolvesToZero() public view {
        assertEq(registry.canonicalOf("NOPE"), address(0));
    }

    function test_onlyOwnerCanWrite() public {
        vm.prank(STRANGER);
        vm.expectRevert(ArcAssetRegistry.NotOwner.selector);
        registry.setAsset(FAKE, "USDC", "an attempted hijack");
    }

    function test_removeMakesAddressNonCanonical() public {
        registry.removeAsset(USDC);
        assertFalse(registry.isCanonical(USDC));
        assertEq(registry.canonicalOf("USDC"), address(0));
    }

    function test_zeroAddressRejected() public {
        vm.expectRevert(ArcAssetRegistry.ZeroAddress.selector);
        registry.setAsset(address(0), "USDC", "nope");
    }

    function test_emptySymbolRejected() public {
        vm.expectRevert(ArcAssetRegistry.EmptySymbol.selector);
        registry.setAsset(FAKE, "", "nope");
    }

    function test_countCountsDistinctAddressesOnce() public {
        registry.setAsset(USDC, "USDC", "updated role");
        assertEq(registry.count(), 1);
        registry.setAsset(FAKE, "OTHER", "another");
        assertEq(registry.count(), 2);
    }

    function test_renounceLocksTheRegistry() public {
        registry.renounceOwnership();
        assertEq(registry.owner(), address(0));
        vm.expectRevert(ArcAssetRegistry.NotOwner.selector);
        registry.setAsset(FAKE, "X", "y");
    }
}
