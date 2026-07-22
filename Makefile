.PHONY: force webapp androidapp androidapp-run

# `force` is a modifier for `webapp`, not a standalone restart.
force:
	@:

webapp:
	@pwsh -NoProfile -File scripts/webapp.ps1 $(if $(filter force,$(MAKECMDGOALS)),-Force,)

androidapp:
	@pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/android-app.ps1

androidapp-run:
	@pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/android-app.ps1 -StartApi
