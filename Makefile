.PHONY: force webapp

# `force` is a modifier for `webapp`, not a standalone restart.
force:
	@:

webapp:
	@pwsh -NoProfile -File scripts/webapp.ps1 $(if $(filter force,$(MAKECMDGOALS)),-Force,)
