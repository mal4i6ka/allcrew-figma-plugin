"""`python -m allcrew_channel` entry point — same as the `allcrew-channel` console script."""

import sys

from .cli import main

sys.exit(main())
