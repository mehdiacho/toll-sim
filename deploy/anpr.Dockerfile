# The plate reader service (ONNX Runtime, no torch). Build from the repo root:
#   docker build -f deploy/anpr.Dockerfile .
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# The model was trained on Windows fonts; Liberation and DejaVu are the closest free ones.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation fonts-dejavu-core fonts-dejavu-extra \
 && rm -rf /var/lib/apt/lists/* \
 && pip install numpy==2.5.4 pillow==13.0.0 onnxruntime==1.31.0
WORKDIR /app/anpr
COPY anpr/server.py anpr/codec.py anpr/plates.py ./
COPY anpr/out/crnn.onnx ./out/
RUN useradd --system --uid 10002 anpr
USER anpr
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4100/health', timeout=4)"
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "4100"]
