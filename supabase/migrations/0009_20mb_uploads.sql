-- Photos, invoices and PDFs up to 20 MB (was 15 MB)
update storage.buckets set file_size_limit = 20971520 where id = 'media';
