# One public HTTP(S) endpoint for both the browser client and the game socket.
# Render (and other PaaS providers) supplies PORT at runtime; nginx is the only
# process exposed outside the container, while the Haskell server remains on
# its private loopback port 8080.
FROM fpco/stack-build:lts-21.25 AS builder

WORKDIR /build
COPY stack.yaml package.yaml tankwar.cabal ./
RUN stack --system-ghc build --only-dependencies

COPY src ./src
COPY server ./server
RUN stack --system-ghc build --copy-bins --local-bin-path /out

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      ca-certificates \
      gettext-base \
      libgmp10 \
      libnuma1 \
      nginx \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

COPY --from=builder /out/tankwar-server /usr/local/bin/tankwar-server
COPY web /usr/share/nginx/html
COPY deploy/nginx.conf.template /etc/nginx/nginx.conf.template
COPY deploy/start-tankwar.sh /usr/local/bin/start-tankwar

RUN chmod 755 /usr/local/bin/start-tankwar

ENV PORT=10000
EXPOSE 10000

ENTRYPOINT ["/usr/local/bin/start-tankwar"]
