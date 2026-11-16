# syntax=docker/dockerfile:1.7
FROM node:24.22.1-bookworm@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02 AS node_toolchain

FROM postgres:17.7-bookworm@sha256:e9243ab06e47223dedeb3c129fa9ece8d37f506bdc6ee943afb9335f98bb4854

ARG DEBIAN_SNAPSHOT=20260203T000000Z
COPY --from=node_toolchain /usr/local/ /usr/local/

RUN printf '%s\n' \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm-updates main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
      build-essential=12.9 \
      bubblewrap=0.8.0-2+deb12u1 \
      coreutils=9.1-1 \
      git=1:2.39.5-0+deb12u3 \
      python3=3.11.2-1+b1 \
      python3-dev=3.11.2-1+b1 \
      util-linux=2.38.1-5+deb12u3 \
    && rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:9f58bff01604cb1b14008fef14dceb14d836a49225e45c6c2e37de3be3e707f0 \
  https://registry.npmjs.org/npm/-/npm-11.19.1.tgz /tmp/npm.tgz
ADD --checksum=sha256:b922e4676a74ecd9b5b82b45339a7514ca65e750b9ef2d5309f1454b7a5d326f \
  https://registry.npmjs.org/corepack/-/corepack-0.34.5.tgz /tmp/corepack.tgz
ADD --checksum=sha256:9bee59c7313a216722c079c1e22160dea7f88df4e0c3450b1d7b01b882336c6a \
  https://registry.npmjs.org/pnpm/-/pnpm-9.15.4.tgz /tmp/pnpm.tgz
ADD --checksum=sha256:492bca8e813411386e61e488f95b375262aa8f262e6e8b20d162e26bdf025f16 \
  https://registry.npmjs.org/node-gyp/-/node-gyp-12.1.0.tgz /tmp/node-gyp.tgz

RUN npm install --global --force /tmp/corepack.tgz /tmp/pnpm.tgz /tmp/node-gyp.tgz \
    && npm install --global --force /tmp/npm.tgz \
    && ln -sfn /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && rm /tmp/npm.tgz /tmp/corepack.tgz /tmp/pnpm.tgz /tmp/node-gyp.tgz \
    && test "$(node --version)" = v24.22.1 \
    && test "$(npm --version)" = 11.19.1 \
    && test "$(corepack --version)" = 0.34.5 \
    && test "$(pnpm --version)" = 9.15.4 \
    && test "$(node-gyp --version)" = v12.1.0 \
    && test "$(git --version)" = "git version 2.39.5" \
    && test "$(python3 --version)" = "Python 3.11.2" \
    && test "$(postgres --version)" = "postgres (PostgreSQL) 17.7 (Debian 17.7-3.pgdg12+1)"

ENV PATH=/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin
ENTRYPOINT []
CMD ["node", "--version"]
