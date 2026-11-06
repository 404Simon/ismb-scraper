#!/bin/bash -l
#SBATCH --job-name=ismb-embed
#SBATCH --partition=a100
#SBATCH --gres=gpu:a100:1
#SBATCH --cpus-per-task=8
#SBATCH --time=04:00:00
#SBATCH --output=ismb-embed-%j.out
#SBATCH --error=ismb-embed-%j.err
#SBATCH --export=ALL
#
# Embed ISMB papers on FAU TinyGPU. Submit from the repository root:
#   sbatch.tinygpu hpc/embed.slurm
# Do not add #SBATCH --mem: FAU rejects it for GPU jobs.
#
# Frontend setup on the login/submit host:
#   uv sync --project semantic           # creates semantic/.venv; the venv is not rsynced
#   export HF_HOME=/home/woody/iwbn/$USER/hf-cache
#   uv run --project semantic hf download zeroentropy/zembed-1-embedding
#   rsync -a output/ismb-20{22,23,24,25,26} <host>:<repo>/output/
#   sbatch.tinygpu hpc/embed.slurm
#   rsync -a <host>:<repo>/output/semantic/ output/semantic/
#
# `uv sync` and the model cache must exist on the login/submit host where the job
# starts. The venv is not rsynced; create it there.
#
# This job only embeds. Run cluster and label on the frontend.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-${SLURM_SUBMIT_DIR:-$PWD}}"
SOURCE="${SOURCE:-${PROJECT_ROOT}/output}"
OUTPUT="${OUTPUT:-${PROJECT_ROOT}/output/semantic}"
YEARS="${YEARS:-2022 2023 2024 2025 2026}"
HF_HOME="${HF_HOME:-/home/woody/iwbn/${USER}/hf-cache}"

export HF_HOME
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export TOKENIZERS_PARALLELISM=false
export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-8}"

cd "${PROJECT_ROOT}"

command -v uv >/dev/null 2>&1 || { echo "Missing uv; run 'uv sync --project semantic' on the frontend first." >&2; exit 2; }
[[ -x semantic/.venv/bin/python ]] || { echo "Missing semantic/.venv; run 'uv sync --project semantic' on the frontend first." >&2; exit 2; }
for year in ${YEARS}; do
  [[ -d "${SOURCE}/ismb-${year}" ]] || {
    echo "Missing scraped papers for ${year} under ${SOURCE}; copy the ismb-* directories there." >&2
    exit 2
  }
done
if [[ "${HF_HUB_OFFLINE}" == "1" && ! -d "${HF_HOME}/hub/models--zeroentropy--zembed-1-embedding" ]]; then
  echo "Model not cached under ${HF_HOME}." >&2
  echo "Run on the frontend: HF_HOME=${HF_HOME} uv run --project semantic hf download zeroentropy/zembed-1-embedding" >&2
  exit 2
fi

mkdir -p "${OUTPUT}"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
semantic/.venv/bin/python -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"

# shellcheck disable=SC2086  # YEARS is a deliberate list
uv run --project semantic --no-sync ismb-semantic embed \
  --source "${SOURCE}" \
  --output "${OUTPUT}" \
  --years ${YEARS} \
  --reuse \
  "$@"
