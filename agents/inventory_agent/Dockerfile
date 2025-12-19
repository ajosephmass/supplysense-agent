FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app.py /app/app.py

# Run the AgentCore app
ENTRYPOINT ["python", "app.py"]