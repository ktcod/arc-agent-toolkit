// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ArcAssetRegistry
 * @notice An on-chain record of canonical Circle infrastructure on Arc.
 *
 * On Arc, USDC is the gas asset, which makes its ticker the highest-value thing to squat on the
 * chain. Tokens trading as USDC-alikes already exist. An off-chain allowlist answering "is this
 * the real USDC?" asks you to trust the API serving it; this contract exists so the answer can
 * be checked on-chain instead.
 *
 * Deliberately NOT upgradeable and NOT a proxy. A registry of canonical addresses whose
 * implementation can change out from under readers defeats its own purpose.
 */
contract ArcAssetRegistry {
    struct Asset {
        string symbol;
        string role;
        bool canonical;
    }

    address public owner;

    mapping(address => Asset) private _assets;
    mapping(bytes32 => address) private _bySymbol;
    address[] private _addresses;

    event AssetSet(address indexed account, string symbol, string role);
    event AssetRemoved(address indexed account, string symbol);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error EmptySymbol();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    /// @notice Register or update a canonical asset.
    function setAsset(address account, string calldata symbol, string calldata role) public onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (bytes(symbol).length == 0) revert EmptySymbol();

        if (!_assets[account].canonical) {
            _addresses.push(account);
        }
        _assets[account] = Asset({symbol: symbol, role: role, canonical: true});
        _bySymbol[keccak256(bytes(symbol))] = account;

        emit AssetSet(account, symbol, role);
    }

    /// @notice Register many assets in one transaction. Used once at deployment.
    function setAssets(
        address[] calldata accounts,
        string[] calldata symbols,
        string[] calldata roles
    ) external onlyOwner {
        require(accounts.length == symbols.length && symbols.length == roles.length, "length mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            setAsset(accounts[i], symbols[i], roles[i]);
        }
    }

    /// @notice Remove an asset. The address stays in the enumeration but reads as non-canonical.
    function removeAsset(address account) external onlyOwner {
        Asset memory existing = _assets[account];
        delete _bySymbol[keccak256(bytes(existing.symbol))];
        delete _assets[account];
        emit AssetRemoved(account, existing.symbol);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Give up control permanently, freezing the registry as a public record.
    function renounceOwnership() external onlyOwner {
        emit OwnerChanged(owner, address(0));
        owner = address(0);
    }

    /// @notice Is this address canonical Circle infrastructure on Arc?
    function isCanonical(address account) external view returns (bool) {
        return _assets[account].canonical;
    }

    /// @notice The symbol registered for an address, or "" if none.
    function symbolOf(address account) external view returns (string memory) {
        return _assets[account].symbol;
    }

    /// @notice What this contract is, in one phrase.
    function roleOf(address account) external view returns (string memory) {
        return _assets[account].role;
    }

    /// @notice The canonical address for a symbol, or address(0) if unknown.
    function canonicalOf(string calldata symbol) external view returns (address) {
        return _bySymbol[keccak256(bytes(symbol))];
    }

    /// @notice How many addresses have ever been registered.
    function count() external view returns (uint256) {
        return _addresses.length;
    }

    /// @notice Enumerate registered addresses, for independent auditing of the whole set.
    function addressAt(uint256 index) external view returns (address) {
        return _addresses[index];
    }
}
