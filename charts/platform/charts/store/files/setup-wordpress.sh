#!/bin/sh
set -eu
trap 'status=$?; if [ "$status" -ne 0 ]; then touch /shared/setup-failed; fi' EXIT

cd /var/www/html

until [ -f wp-config.php ] && [ -f wp-includes/version.php ]; do
  echo "Waiting for WordPress files and configuration"
  sleep 5
done

until wp db check --quiet; do
  echo "Waiting for MariaDB"
  sleep 5
done

if ! wp core is-installed; then
  wp core install \
    --url="$SITE_URL" \
    --title="$SITE_TITLE" \
    --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" \
    --skip-email
fi

wp option update siteurl "$SITE_URL"
wp option update home "$SITE_URL"
wp option update timezone_string Asia/Kolkata
wp rewrite structure '/%postname%/' --hard

if ! wp plugin is-installed woocommerce; then
  wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --activate
elif [ "$(wp plugin get woocommerce --field=version --format=bare)" != "$WOOCOMMERCE_VERSION" ]; then
  wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --activate --force
elif ! wp plugin is-active woocommerce; then
  wp plugin activate woocommerce
fi

wp eval-file /scripts/setup-commerce.php
mkdir -p /var/www/html/wp-content/mu-plugins
cp /scripts/enable-application-passwords.php /var/www/html/wp-content/mu-plugins/enable-application-passwords.php

if ! wp user get "$API_USER" >/dev/null 2>&1; then
  API_USER_PASSWORD="$(wp eval 'echo wp_generate_password(32, true, true);')"
  wp user create "$API_USER" "$API_EMAIL" --role=shop_manager --user_pass="$API_USER_PASSWORD"
fi

if [ -f /shared/generate-api-password ]; then
  API_USER_ID="$(wp user get "$API_USER" --field=ID)"
  wp user application-password delete-all "$API_USER_ID" >/dev/null 2>&1 || true
  API_PASSWORD="$(wp user application-password create "$API_USER_ID" urumi-mcp --porcelain)"
  umask 027
  printf '%s\n%s\n' "$API_USER" "$API_PASSWORD" > /shared/woo-api-credentials
fi
