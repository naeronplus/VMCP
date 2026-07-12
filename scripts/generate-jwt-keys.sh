#!/usr/bin/env bash
# Generate RS256 key pair for production JWT signing
set -euo pipefail
mkdir -p secrets
openssl genrsa -out secrets/jwt-private.pem 2048
openssl rsa -in secrets/jwt-private.pem -pubout -out secrets/jwt-public.pem
echo "Wrote secrets/jwt-private.pem and secrets/jwt-public.pem"
