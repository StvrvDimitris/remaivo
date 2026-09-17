CREATE TABLE `v3_payment_links` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`occurrence_id` text NOT NULL
);
