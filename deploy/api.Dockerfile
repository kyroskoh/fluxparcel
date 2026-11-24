FROM golang:1.25-alpine AS build
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /fluxparcel ./cmd/fluxparcel

FROM alpine:3.23
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=755 --from=build /fluxparcel /usr/local/bin/fluxparcel
USER 65532:65532
ENTRYPOINT ["fluxparcel"]
CMD ["api"]
