#!/bin/sh
# Dev-only TLS material for the balashikshana Dwara edge (issue #65):
# self-signed server pair for the public listener, plus a client CA and
# client certificate for the mTLS-only admin API. Mirrors the upstream
# quickstart pattern (ShristiLabs/dwara quickstart/gen-certs.sh). NOT for
# staging/prod: real environments bring operator-issued material (see
# docs/gateway.md "Certificates" — provisioned via SSM-injected env by the
# Terraform gateway module).
#
# Output: deploy/dwara/certs/ (gitignored — NEVER commit key material;
# enforced by the infra secret-scan test).
set -eu
cd "$(dirname "$0")"
mkdir -p certs
umask 077 # private keys stay owner-only

# --- Server certificate (public listener TLS termination, port 8443) ---
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:gateway.dev.balashikshana.example,IP:127.0.0.1"
chmod 600 certs/server.key
chmod 644 certs/server.crt

# --- Client CA + client certificate (admin API mTLS, port 2019) ---
# The gateway trusts the CA (admin.tls.client_ca_file); the operator's
# curl presents the signed cert — the certificate IS the admin auth.
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/client-ca.key -out certs/client-ca.crt \
  -subj "/CN=balashikshana-dev-client-ca"
openssl req -newkey rsa:2048 -nodes \
  -keyout certs/client.key -out certs/client.csr \
  -subj "/CN=balashikshana-admin"
openssl x509 -req -in certs/client.csr \
  -CA certs/client-ca.crt -CAkey certs/client-ca.key \
  -CAcreateserial -days 365 -out certs/client.crt
chmod 600 certs/client.key certs/client-ca.key
chmod 644 certs/client.crt certs/client-ca.crt
rm -f certs/client.csr certs/client-ca.srl

echo "wrote deploy/dwara/certs/ (server pair + client CA + admin client cert)"
echo "dev-only self-signed material; regenerate freely, never commit"
