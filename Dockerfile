FROM nginx:alpine

# Laita konffi templaatiksi tähän polkuun -> entrypoint tekee envsubstin automaattisesti
COPY default.conf.template /etc/nginx/templates/default.conf.template

# Aja Nginx foreground-tilassa
CMD ["nginx", "-g", "daemon off;"]
