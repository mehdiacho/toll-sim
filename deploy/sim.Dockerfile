# The SUMO simulation bridge in always-on mode. Build from the repo root:
#   docker build -f deploy/sim.Dockerfile .
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# The SUMO wheel links X11/GL even for headless sumo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libx11-6 libxext6 libxrender1 libgl1 libatomic1 libexpat1 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install eclipse-sumo==1.28.0 traci==1.28.0 sumolib==1.28.0 \
 && python -c "import sumo, sys; sys.stdout.write(sumo.SUMO_HOME)" > /sumo_home \
 && ln -s "$(cat /sumo_home)" /opt/sumo
ENV SUMO_HOME=/opt/sumo
WORKDIR /app/sim
COPY sim/bridge.py sim/demand.py sim/a1.sumocfg ./
COPY sim/net/a1.net.xml sim/net/gantries.add.xml sim/net/corridor.json sim/net/a1.rou.xml ./net/
# The bridge writes net/types.rou.xml at start and keeps its fleet in /data.
RUN useradd --system --uid 10001 sim && mkdir -p /data && chown -R sim /app/sim /data \
 && sumo --version > /tmp/sumo-version && head -1 /tmp/sumo-version
USER sim
ENV FLEET_FILE=/data/fleet.json
CMD ["python", "bridge.py", "--live"]
