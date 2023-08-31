.PHONY: terraform-apply
terraform-apply: terraform-init
	cd terraform; terraform apply

.PHONY: terraform-init
terraform-init:
	cd terraform; terraform init

.PHONY: terraform-format
terraform-format:
	cd terraform; terraform fmt