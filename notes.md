Phase 1 
-Built: MariaDB StatefulSet, WordPress Deployment, both on PVCs, and an idempotent setup Job.
-Decision and why: I pinned WooCommerce to 10.3.6 so upstream releases can’t break the deploy.
-Broke: the bitnami/kubectl tag vanished from Docker Hub, and the latest WooCommerce needed WordPress 7.0. I diagnosed both from kubectl describe and the Job logs.


