# GPT-2 XL Discord Bot Dockerfile
# Supports both CPU and GPU (NVIDIA CUDA) execution

FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY bot.py .
COPY .env.example .

# Create volume mount point for .env file
VOLUME ["/app/.env"]

# Environment variables (can be overridden)
ENV PYTHONUNBUFFERED=1
ENV DEVICE=auto

# Run the bot
CMD ["python", "bot.py"]
