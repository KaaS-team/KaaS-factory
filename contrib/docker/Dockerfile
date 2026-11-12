# Build from the repo root: docker build -f contrib/docker/Dockerfile -t factory .
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/factory ./cmd/factory

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/factory /factory
USER nonroot:nonroot
EXPOSE 8787
# 0.0.0.0 inside the container; publish the port to 127.0.0.1 on the host.
ENTRYPOINT ["/factory", "serve", "--addr", "0.0.0.0:8787"]
