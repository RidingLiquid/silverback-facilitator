#!/bin/bash

# Setup Foundry for X402FeeSplitter testing
# Run: bash scripts/setup-foundry.sh

set -e

echo "🔧 Setting up Foundry for X402FeeSplitter..."

# Check if Foundry is installed
if ! command -v forge &> /dev/null; then
    echo "❌ Foundry not installed. Installing..."
    curl -L https://foundry.paradigm.xyz | bash
    source ~/.bashrc
    foundryup
fi

echo "✅ Foundry version: $(forge --version)"

# Install dependencies
echo "📦 Installing dependencies..."

# Create lib directory
mkdir -p lib

# Install OpenZeppelin contracts
if [ ! -d "lib/openzeppelin-contracts" ]; then
    echo "  Installing OpenZeppelin..."
    git clone --depth 1 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
fi

# Install forge-std
if [ ! -d "lib/forge-std" ]; then
    echo "  Installing forge-std..."
    git clone --depth 1 https://github.com/foundry-rs/forge-std.git lib/forge-std
fi

echo "✅ Dependencies installed"

# Build contracts
echo "🔨 Building contracts..."
forge build

# Run tests
echo "🧪 Running tests..."
forge test -vvv

# Gas report
echo "⛽ Gas report..."
forge test --gas-report

echo ""
echo "✅ Setup complete!"
echo ""
echo "Available commands:"
echo "  forge test          - Run all tests"
echo "  forge test -vvv     - Run tests with verbose output"
echo "  forge test --match-test test_SplitPayment  - Run specific tests"
echo "  forge coverage      - Generate coverage report"
