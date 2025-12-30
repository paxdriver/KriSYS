FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 libjpeg-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

ENV BLOCKCHAIN_DB_PATH=/app/blockchain/blockchain.db
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

EXPOSE 5000

CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app", "--workers", "2", "--reload"]
