
<?php

$cod_settings = get_option('woocommerce_cod_settings', array());
$cod_settings['enabled'] = 'yes';
$cod_settings['title'] = 'Cash on Delivery';
$cod_settings['description'] = '';
$cod_settings['instructions'] = '';
update_option('woocommerce_cod_settings', $cod_settings);
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_store_pages_only', 'no');
echo "WooCommerce store visibility set to Live.\n";

if (wc_get_products(array('limit' => 1))) {
    return;
}

$samples = array(
    array('name' => 'Classic T-Shirt', 'price' => '499'),
    array('name' => 'Ceramic Mug', 'price' => '299'),
    array('name' => 'Canvas Tote Bag', 'price' => '399'),
);

foreach ($samples as $sample) {
    $product = new WC_Product_Simple();
    $product->set_name($sample['name']);
    $product->set_regular_price($sample['price']);
    $product->set_status('publish');
    $product->set_catalog_visibility('visible');
    $product->save();
}
