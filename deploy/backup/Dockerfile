# Backup runner: the official Postgres client tools plus the openssl CLI used
# to encrypt dumps. Built once with internet access; at runtime the container
# sits only on the internal network.
FROM postgres:16-alpine
RUN apk add --no-cache openssl
COPY backup.sh backup-loop.sh restore.sh /scripts/
