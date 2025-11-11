# Välikerros Tesla Vehicle Command -proxylle
FROM nginx:alpine

# Kopioidaan oma konfiguraatio
COPY nginx.conf /etc/nginx/nginx.conf

# Render kuuntelee oletusporttia (ENV: PORT)
EXPOSE 10000

# Käynnistetään nginx foreground-tilassa
CMD ["nginx", "-g", "daemon off;"]
