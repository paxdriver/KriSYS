# Use official Python image
FROM python:3.9-slim

# Set environment variables
ENV BLOCKCHAIN_DB_PATH=/data/blockchain.db
ENV PYTHONUNBUFFERED=1

# Create app directory
WORKDIR /app

# Install dependencies
COPY src/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app source
COPY src /app

# Expose port
EXPOSE 5000

# Run application
CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app", "--workers", "2"]