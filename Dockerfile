FROM rust:1.89
WORKDIR /app
# Install dependencies for TDLib
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    libc++1 \
    libc++abi1 \
    libunwind8 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY . .
ARG ACC
RUN mkdir telegram2_db
RUN echo ${ACC} | base64 -d > ./telegram2_db/td.binlog
RUN cargo build --release
CMD ["/app/target/release/telegram2"]
