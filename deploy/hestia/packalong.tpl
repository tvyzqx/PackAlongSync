server {
    listen      %ip%:%proxy_port%;
    listen      [::]:%proxy_port%;
    server_name %domain_idn% %alias_idn%;

    root %docroot%;

    include %home%/%user%/conf/web/%domain%/nginx.conf_letsencrypt*;

    # Redirect all plain HTTP to HTTPS.
    location / {
        return 301 https://$host$request_uri;
    }
}
