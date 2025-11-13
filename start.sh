#!/bin/bash

# 3Panel Data Analyzer - Startup Script
# This script helps start the app cleanly

echo "🧹 Cleaning up any existing processes..."

# Kill any processes on ports 3000 and 3001
lsof -ti:3000 | xargs kill -9 2>/dev/null
lsof -ti:3001 | xargs kill -9 2>/dev/null

sleep 1

echo "🚀 Starting servers..."
echo ""

# Start both servers
npm run dev
