FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/web/ apps/web/
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist/ /usr/share/nginx/html/
