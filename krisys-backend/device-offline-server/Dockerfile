FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
	curl \
	gnupg \
	&& rm -rf /var/lib/apt/lists/*

# Install Node.js (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
	&& apt-get install -y nodejs

WORKDIR /app

# Install Python deps
COPY ./requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy station app
COPY ./device-offline-server/ /app

# Install Node deps for RTC host
WORKDIR /app/rtc-host
RUN npm install

WORKDIR /app

EXPOSE 5000
EXPOSE 7000

# Start BOTH Flask and Node
CMD bash -c "node rtc-host/server.js & gunicorn -b 0.0.0.0:5000 app:app --workers 1 --reload"