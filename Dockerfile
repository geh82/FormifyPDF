FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-opencv \
    python3-pil \
    python3-pypdf \
    tesseract-ocr \
    tesseract-ocr-eng \
    && pip3 install --no-cache-dir --break-system-packages pymupdf pdfplumber pytesseract \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

COPY . .
RUN npm run build

RUN mkdir -p storage/formforge public/generated public/signed uploaded-zips

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.ts"]
