FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 go build -o /commit-agent ./cmd/agent

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /commit-agent /usr/local/bin/commit-agent
ENTRYPOINT ["/usr/local/bin/commit-agent"]
