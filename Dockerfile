FROM nginx:alpine
RUN printf 'events {}\n\
http {\n\
  server {\n\
    listen ${PORT:-10000};\n\
    location / {\n\
      proxy_pass https://vcp-core:10000;\n\
      proxy_ssl_verify off;\n\
      proxy_set_header Host $host;\n\
      proxy_set_header X-Forwarded-Proto https;\n\
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
    }\n\
  }\n\
}\n' > /etc/nginx/nginx.conf
CMD ["nginx", "-g", "daemon off;"]
