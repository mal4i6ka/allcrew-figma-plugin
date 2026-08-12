"""`python -m altery_dj` entry point — same as the `altery-dj` console script."""

import sys

from .cli import main

sys.exit(main())
