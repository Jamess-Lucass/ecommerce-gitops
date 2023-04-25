.PHONY: terraform-apply
terraform-apply:
	dotenv -- sh -c 'cd terraform; terraform apply'