# Adapted from agent-director 2e528ea; built/run only by jobsched remotely.
FROM eclipse-temurin:21-jre
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . /work/
ENV TLA_REMOTE_JOB=1
RUN chmod 0755 /work/tlcjob.sh && java -version
CMD ["/work/tlcjob.sh"]
