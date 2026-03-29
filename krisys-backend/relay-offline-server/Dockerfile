# krisys-backend/relay-offline-server/Dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
	libsqlite3-0 \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Reuse top-level requirements (same deps as central backend)
COPY ./requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Relay will pull data from central when online, 0 means it only gets blocks from peers
ENV RELAY_AUTO_PULL=1

# Copy only the relay app
COPY ./relay-offline-server/ /app
# Copy the shared utility function for relay's local blockchain validation/reconciliation
COPY canonical_block.py /app/
COPY reconcile_local_chain.py /app/

EXPOSE 5000

CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app", "--workers", "1", "--reload"]