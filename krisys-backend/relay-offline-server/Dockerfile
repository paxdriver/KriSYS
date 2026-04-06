# krisys-backend/relay-offline-server/Dockerfile
FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
	curl \
	gnupg \
	&& rm -rf /var/lib/apt/lists/*

# Install Node.js (LTS 18 to match station)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
	&& apt-get install -y nodejs

WORKDIR /app

# Install Python deps
COPY ./requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Relay will pull data from central when online, 0 means it only gets blocks from peers
ENV RELAY_AUTO_PULL=1
# Optional: Setting CENTRAL_API_URL enables:
# 1) Central auto-provisioning (if UNINITIALIZED)
# 2) Central block pull (if RELAY_AUTO_PULL=1)
# Omit for station-only provisioning
ENV CENTRAL_API_URL=http://localhost:5000

# Copy only the relay app
COPY ./relay-offline-server/ /app
# Copy the shared utility function for relay's local blockchain validation/reconciliation
COPY canonical_block.py /app/
COPY reconcile_local_chain.py /app/

# Install Node deps for RTC host
WORKDIR /app/rtc-host
RUN npm install

WORKDIR /app

EXPOSE 5000
EXPOSE 7000

# Start BOTH Flask and Node
CMD bash -c "node rtc-host/server.js & gunicorn -b 0.0.0.0:5000 app:app --workers 1 --reload"