# Live Transcriber in one image: Node app + whisper.cpp + Python/NeMo (for Jackrabbit).
# Docker on macOS runs a Linux VM without access to the Apple GPU, so every model runs on the CPU here.
#
#   docker compose up --build        then open http://localhost:3000

# --- whisper.cpp (whisper-server, whisper-quantize), CPU build -------------------------------------------
# GGML_NATIVE mis-detects fp16 support inside Docker's VM, so the Apple-silicon features it exposes are named.
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG WHISPER_CPP_VERSION=v1.9.5
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+fp16+dotprod+i8mm \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON \
 && cmake --build /build -j --target whisper-server whisper-quantize \
 && mkdir /out && cp /build/bin/whisper-server /build/bin/whisper-quantize /out/

# --- Python 3.12 + CPU PyTorch + NeMo, built where compilers are available ----------------------------------
FROM python:3.12-bookworm AS python
WORKDIR /app
COPY python/requirements.txt python/requirements.txt
RUN python -m venv python/.venv \
 && python/.venv/bin/pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
 && python/.venv/bin/pip install --no-cache-dir -r python/requirements.txt

# --- Runtime ------------------------------------------------------------------------------------------------
FROM python:3.12-slim-bookworm
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update && apt-get install -y --no-install-recommends libgomp1 libsndfile1 libvulkan1 unzip bzip2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /out/ /usr/local/bin/
WORKDIR /app
COPY --from=python /app/python/.venv python/.venv
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

# Listen on all interfaces inside the container; docker-compose.yml publishes it on 127.0.0.1 only.
ENV HOST=0.0.0.0 PORT=3000 THREADS=8 SETTINGS_FILE=/app/state/settings.json IN_DOCKER=1
EXPOSE 3000
CMD ["node", "server.js"]
